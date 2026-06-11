/*
 * progressive.js — Gold Coins Casino Virtual Progressive Controller
 * Stray-Pup LLC / The Turrelle Sisters LLC
 * v1.6 — Merged game-client library + schema-complete hit inserts.
 *
 * WHAT THIS FILE IS:
 *   Drop-in for every game client (TSBIGMUNNY, StrayPups variants, etc.).
 *   The operator dashboard (progressive_operator/index.html) is self-contained
 *   and does NOT load this file — all _op_* logic lives inline there.
 *
 * MULTI-USER FIXES carried forward from v1.3:
 *  1. Channel name collision — all channels include _sessionKey suffix so
 *     each client is unique; second subscriber no longer silently dropped.
 *  2. prog-commands channel extended to full session key.
 *  3. Contribution flush: in-flight guard prevents concurrent double-sends.
 *  4. Presence channel 'presence-lobby' intentionally shared — unchanged.
 *  5. Reconnect: exponential-backoff re-subscribe on dropped WebSocket.
 *  6. Four separate postgres_changes channels consolidated into ONE per
 *     session — reduces WebSocket slots, fixes Edge Function overload.
 *
 * v1.4 — Fast connect + presence sync.
 * v1.5 — Version bump; all v1.4 fixes carried forward.
 * v1.6 — hit() and claimForce() now write all schema columns to
 *         progressive_hits: player_session, player_label, game_title,
 *         win_patterns. Matches SQL schema as of 2026-06-10.
 *
 * ES5 only. No arrow functions. No const/let. No backticks. No async/await.
 */

var SUPABASE_URL      = 'https://gdmmoeggkqsvqnqyrubx.supabase.co';
var SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdkbW1vZWdna3FzdnFucXlydWJ4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA4MDYzNTQsImV4cCI6MjA5NjM4MjM1NH0.i86afL3CMpmru4z3LZAbCJkxBiwo25QbwEji8tDBAis';

/* Per-game identity — set via inline script BEFORE this file loads:
     var PROG_GAME_ID = 'straypups_5d';
     var PROG_DENOM   = 5.00;
*/
var PROG_GAME_ID = (typeof PROG_GAME_ID !== 'undefined') ? PROG_GAME_ID : 'unknown';
var PROG_DENOM   = (typeof PROG_DENOM   !== 'undefined') ? PROG_DENOM   : 1.00;

var Progressive = (function () {

  /* FIX-1: Preload the Supabase SDK immediately when this script loads.
     By the time init() is called the script will already be cached/parsed,
     cutting connect latency by 1-3 seconds. */
  (function _preloadSDK() {
    if (typeof window !== 'undefined' && !window.supabase) {
      var s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js';
      s.async = true;
      document.head.appendChild(s);
    }
  }());

  /* Private state */
  var _client           = null;
  var _connected        = false;
  var _localValue       = 500.00;
  var _seed             = 500.00;
  var _ceiling          = 9999.00;
  var _contribRate      = 0.02;
  var _triggerOdds      = 500;
  var _pendingAdd       = 0;
  var _flushTimer       = null;
  var _flushInFlight    = false;
  var _valueListeners   = [];
  var _presenceChannel  = null;
  var _presenceCount    = 0;
  var _presenceListeners= [];
  var _sessionKey       = 'sess_' + Math.random().toString(36).substr(2, 9);
  var _mainChannel      = null;
  var _reconnectDelay   = 2000;
  var _reconnectTimer   = null;

  /* Force jackpot state */
  var _forceArmed       = false;
  var _forceCommandId   = null;
  var _forceClaimed     = false;
  var _onForceWin       = null;
  var _onForceNotify    = null;
  var _justWon          = false;

  /* Broadcast message state */
  var _messageListeners  = [];
  var _lastSeenMessageId = 0;
  var _SEEN_KEY          = 'prog_last_msg_' + PROG_GAME_ID;

  /* ===============================================================
     SDK LOADER
     =============================================================== */
  function _loadSDK(cb) {
    if (typeof window !== 'undefined' && window.supabase) { cb(); return; }
    var attempts = 0;
    var poll = setInterval(function() {
      attempts++;
      if (window.supabase) { clearInterval(poll); cb(); return; }
      if (attempts >= 50) {
        clearInterval(poll);
        var s = document.createElement('script');
        s.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js';
        s.onload  = cb;
        s.onerror = function () { console.warn('[Progressive] SDK load failed — offline.'); };
        document.head.appendChild(s);
      }
    }, 100);
  }

  /* ===============================================================
     NOTIFY HELPERS
     =============================================================== */
  function _notifyValue() {
    for (var i = 0; i < _valueListeners.length; i++) {
      try { _valueListeners[i](_localValue); } catch (e) {}
    }
  }
  function _notifyPresence() {
    for (var i = 0; i < _presenceListeners.length; i++) {
      try { _presenceListeners[i](_presenceCount); } catch (e) {}
    }
  }
  function _notifyMessage(msg) {
    for (var i = 0; i < _messageListeners.length; i++) {
      try { _messageListeners[i](msg); } catch(e) {}
    }
    _saveLastSeen(msg.id);
  }

  /* ===============================================================
     DB FETCH
     =============================================================== */
  function _fetchRow(cb) {
    _client.from('progressive').select('*').eq('id', 1).single().then(function (res) {
      if (res.error) { console.warn('[Progressive] fetchRow:', res.error.message); if (cb) cb(); return; }
      var d = res.data;
      _localValue  = parseFloat(d.value)        || _seed;
      _seed        = parseFloat(d.seed)         || _seed;
      _ceiling     = parseFloat(d.ceiling)      || _ceiling;
      _contribRate = parseFloat(d.contrib_rate) || _contribRate;
      if (d.trigger_odds != null) _triggerOdds = parseFloat(d.trigger_odds) || _triggerOdds;
      _notifyValue();
      if (cb) cb();
    });
  }

  function _checkArmedCommand() {
    _client.from('progressive_commands')
      .select('*').eq('status', 'armed').limit(1).then(function (res) {
        if (res.error) {
          console.warn('[Progressive] commands table error:', res.error.message);
          return;
        }
        if (!res.data || !res.data.length) return;
        _forceArmed     = true;
        _forceCommandId = res.data[0].id;
        console.log('[Progressive] Force jackpot ARMED on load — fires on next spin!');
      });
  }

  /* ===============================================================
     BROADCAST MESSAGES
     =============================================================== */
  function _loadLastSeen() {
    try { var v = localStorage.getItem(_SEEN_KEY); if (v) _lastSeenMessageId = parseInt(v, 10) || 0; } catch(e) {}
  }
  function _saveLastSeen(id) {
    _lastSeenMessageId = id;
    try { localStorage.setItem(_SEEN_KEY, String(id)); } catch(e) {}
  }
  function _checkUnreadMessages() {
    _loadLastSeen();
    _client.from('broadcast_messages')
      .select('*')
      .gt('id', _lastSeenMessageId)
      .order('id', { ascending: true })
      .then(function(res) {
        if (res.error || !res.data || !res.data.length) return;
        res.data.forEach(function(msg, i) {
          setTimeout(function() { _notifyMessage(msg); }, i * 4000);
        });
      });
  }

  /* ===============================================================
     REALTIME — CONSOLIDATED SINGLE CHANNEL (FIX-1, FIX-6)
     One channel per session (unique name) with all postgres_changes
     listeners attached.
     =============================================================== */
  function _subscribeMain() {
    var chName = 'prog-main-' + _sessionKey;
    _mainChannel = _client.channel(chName)

      .on('postgres_changes', {
        event: 'UPDATE', schema: 'public', table: 'progressive', filter: 'id=eq.1'
      }, function (p) {
        if (!p.new) return;
        _localValue  = parseFloat(p.new.value)        || _localValue;
        _seed        = parseFloat(p.new.seed)         || _seed;
        _ceiling     = parseFloat(p.new.ceiling)      || _ceiling;
        _contribRate = parseFloat(p.new.contrib_rate) || _contribRate;
        if (p.new.trigger_odds != null) _triggerOdds = parseFloat(p.new.trigger_odds) || _triggerOdds;
        _notifyValue();
      })

      .on('postgres_changes', {
        event: 'INSERT', schema: 'public', table: 'progressive_commands'
      }, function (p) {
        if (!p.new || p.new.command !== 'force_jackpot' || p.new.status !== 'armed') return;
        _forceArmed     = true;
        _forceCommandId = p.new.id;
        _forceClaimed   = false;
        console.log('[Progressive] FORCE JACKPOT ARMED — fires on next spin!');
      })

      .on('postgres_changes', {
        event: 'UPDATE', schema: 'public', table: 'progressive_commands'
      }, function (p) {
        if (!p.new || p.new.command !== 'force_jackpot') return;
        if (p.new.status === 'won') {
          if (p.new.winner_session === _sessionKey) return;
          _forceArmed     = false;
          _forceCommandId = null;
          if (_onForceNotify) {
            _onForceNotify(
              parseFloat(p.new.winner_amt) || 0,
              p.new.winner_game || 'another game'
            );
          }
        }
      })

      .on('postgres_changes', {
        event: 'INSERT', schema: 'public', table: 'progressive_hits'
      }, function (p) {
        if (!p.new || _justWon) return;
        if (_onForceNotify) {
          _onForceNotify(
            parseFloat(p.new.amount) || 0,
            p.new.game_id || 'another game'
          );
        }
      })

      .on('postgres_changes', {
        event: 'INSERT', schema: 'public', table: 'broadcast_messages'
      }, function (p) {
        if (!p.new) return;
        _notifyMessage(p.new);
      })

      .subscribe(function (status) {
        if (status === 'SUBSCRIBED') {
          _reconnectDelay = 2000;
          if (_reconnectTimer) { clearTimeout(_reconnectTimer); _reconnectTimer = null; }
          console.log('[Progressive] Realtime connected (' + _sessionKey + ')');
        }
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          console.warn('[Progressive] Realtime ' + status + ' — reconnecting in ' + (_reconnectDelay/1000) + 's');
          _scheduleReconnect();
        }
      });
  }

  function _scheduleReconnect() {
    if (_reconnectTimer) return;
    var delay = _reconnectDelay;
    _reconnectDelay = Math.min(_reconnectDelay * 2, 30000);
    _reconnectTimer = setTimeout(function () {
      _reconnectTimer = null;
      if (!_client) return;
      if (_mainChannel) {
        try { _client.removeChannel(_mainChannel); } catch(e) {}
        _mainChannel = null;
      }
      _subscribeMain();
    }, delay);
  }

  /* ===============================================================
     PRESENCE
     =============================================================== */
  function _subscribePresence() {
    _presenceChannel = _client.channel('presence-lobby', {
      config: { presence: { key: _sessionKey } }
    });
    _presenceChannel
      .on('presence', { event: 'sync' }, function () {
        _presenceCount = Object.keys(_presenceChannel.presenceState()).length;
        _notifyPresence();
      })
      .on('presence', { event: 'join' }, function () {
        _presenceCount = Object.keys(_presenceChannel.presenceState()).length;
        _notifyPresence();
      })
      .on('presence', { event: 'leave' }, function () {
        _presenceCount = Object.keys(_presenceChannel.presenceState()).length;
        _notifyPresence();
      })
      .subscribe(function (status) {
        if (status === 'SUBSCRIBED') {
          _presenceChannel.track({
            gameId:   PROG_GAME_ID,
            denom:    PROG_DENOM,
            joinedAt: new Date().toISOString(),
            lastSpin: null
          });
        }
      });
  }

  /* ===============================================================
     CONTRIBUTION FLUSH
     =============================================================== */
  function _scheduleFlush() {
    if (_flushTimer) return;
    _flushTimer = setTimeout(function () {
      _flushTimer = null;
      if (_pendingAdd <= 0 || !_client || _flushInFlight) return;
      var toAdd   = parseFloat(_pendingAdd.toFixed(4));
      _pendingAdd = 0;
      _flushInFlight = true;
      _client.rpc('progressive_contribute', { add_amount: toAdd }).then(function (res) {
        _flushInFlight = false;
        if (res.error) {
          console.warn('[Progressive] contribute error:', res.error.message);
          _pendingAdd += toAdd;
          _scheduleFlush();
        }
      });
    }, 5000);
  }

  /* ===============================================================
     HIT RECORD BUILDER — writes all progressive_hits schema columns
     info: { pattern, balls, bet, gameTitle, playerLabel, winPatterns }
     =============================================================== */
  function _buildHitRecord(hitAmt, info) {
    return {
      game_id:        PROG_GAME_ID,
      game_title:     (info && info.gameTitle)      ? info.gameTitle    : PROG_GAME_ID,
      denom:          PROG_DENOM,
      amount:         hitAmt,
      pattern:        (info && info.pattern)        ? info.pattern      : 'Progressive Jackpot',
      balls:          (info && info.balls != null)  ? info.balls        : 0,
      bet:            (info && info.bet   != null)  ? info.bet          : 0,
      player_session: _sessionKey,
      player_label:   (info && info.playerLabel)   ? info.playerLabel  : null,
      win_patterns:   (info && info.winPatterns)   ? info.winPatterns  : null
    };
  }

  /* ===============================================================
     FORCE WIN CLAIM — atomic, race-condition safe
     =============================================================== */
  function _claimForceWin(onClaimed) {
    if (!_forceCommandId || _forceClaimed) { onClaimed(false); return; }
    _forceClaimed = true;
    var hitAmt = parseFloat(_localValue.toFixed(2));

    _client.from('progressive_commands')
      .update({
        status:         'won',
        winner_session: _sessionKey,
        winner_game:    PROG_GAME_ID,
        winner_amt:     hitAmt,
        won_at:         new Date().toISOString()
      })
      .eq('id', _forceCommandId)
      .eq('status', 'armed')
      .select()
      .then(function (res) {
        if (res.error || !res.data || !res.data.length) {
          _forceClaimed = false;
          onClaimed(false);
          return;
        }
        _justWon = true;
        setTimeout(function(){ _justWon = false; }, 5000);
        _localValue = _seed;
        _notifyValue();
        _forceArmed = false;
        _client.rpc('progressive_hit', { reset_to: _seed });
        _client.from('progressive_hits').insert(
          _buildHitRecord(hitAmt, { pattern: 'Force Jackpot', balls: 0, bet: 0 })
        );
        onClaimed(true, hitAmt);
      });
  }

  /* ===============================================================
     RANDOM TRIGGER
     Odds scale from 1/_triggerOdds at seed to 1.0 at ceiling.
     =============================================================== */
  function _shouldRandomTrigger() {
    if (_justWon || _forceArmed) return false;
    var range = _ceiling - _seed;
    if (range <= 0) return false;
    var base   = 1 / Math.max(_triggerOdds, 1);
    var growth = Math.max(0, Math.min(1, (_localValue - _seed) / range));
    var chance = base + (1 - base) * growth;
    return Math.random() < chance;
  }

  function _updateLastSpin() {
    if (!_presenceChannel) return;
    try {
      _presenceChannel.track({
        gameId:   PROG_GAME_ID,
        denom:    PROG_DENOM,
        joinedAt: new Date().toISOString(),
        lastSpin: new Date().toISOString()
      });
    } catch(e) {}
  }

  function _fmtMoney(n) {
    var parts = parseFloat(n).toFixed(2).split('.');
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return '$' + parts[0] + '.' + parts[1];
  }

  /* ===============================================================
     PUBLIC API
     =============================================================== */

  function init(onReady) {
    _loadSDK(function () {
      try {
        _client    = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
        _connected = true;
        _fetchRow(function () {
          _subscribeMain();
          _subscribePresence();
          _checkArmedCommand();
          _checkUnreadMessages();
          setInterval(function() { _fetchRow(null); }, 60000);
          if (onReady) onReady();
        });
      } catch (e) {
        console.warn('[Progressive] init failed:', e);
        if (onReady) onReady();
      }
    });
  }

  function contribute(betAmt) {
    if (!betAmt || betAmt <= 0) return false;
    var addition = betAmt * _contribRate;
    _localValue  = _localValue + addition;
    if (_localValue > _ceiling) _localValue = _ceiling;
    _notifyValue();
    if (_connected && _client) {
      _pendingAdd += addition;
      _scheduleFlush();
    }
    _updateLastSpin();
    if (_shouldRandomTrigger()) return 'random';
    return _forceArmed;
  }

  function claimForce(onResult) { _claimForceWin(onResult); }

  function hit(info) {
    var hitAmt  = parseFloat(_localValue.toFixed(2));
    _localValue = _seed;
    _notifyValue();
    _justWon = true;
    setTimeout(function() { _justWon = false; }, 5000);
    if (_connected && _client) {
      _client.rpc('progressive_hit', { reset_to: _seed });
      _client.from('progressive_hits').insert(_buildHitRecord(hitAmt, info));
      setTimeout(function() { _fetchRow(null); }, 1000);
    }
    return hitAmt;
  }

  function mustHit()          { return _localValue >= _ceiling; }
  function getDisplay()       { return _fmtMoney(_localValue); }
  function getValue()         { return _localValue; }
  function isConnected()      { return _connected; }
  function isForceArmed()     { return _forceArmed; }
  function getTriggerOdds()   { return _triggerOdds; }
  function getPresenceCount() { return _presenceCount; }
  function getSessionKey()    { return _sessionKey; }

  function onChange(fn)         { _valueListeners.push(fn);    fn(_localValue); }
  function onPresenceChange(fn) { _presenceListeners.push(fn); fn(_presenceCount); }
  function onMessage(fn)        { _messageListeners.push(fn); }
  function onForceWin(fn)       { _onForceWin    = fn; }
  function onForceNotify(fn)    { _onForceNotify = fn; }

  return {
    init:             init,
    contribute:       contribute,
    claimForce:       claimForce,
    hit:              hit,
    mustHit:          mustHit,
    getDisplay:       getDisplay,
    getValue:         getValue,
    isConnected:      isConnected,
    isForceArmed:     isForceArmed,
    getTriggerOdds:   getTriggerOdds,
    getPresenceCount: getPresenceCount,
    getSessionKey:    getSessionKey,
    onChange:         onChange,
    onPresenceChange: onPresenceChange,
    onMessage:        onMessage,
    onForceWin:       onForceWin,
    onForceNotify:    onForceNotify
  };
}());
