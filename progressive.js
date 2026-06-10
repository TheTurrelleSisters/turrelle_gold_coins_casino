/*
 * progressive.js — Virtual Progressive Controller
 * Stray-Pup LLC / The Turrelle Sisters LLC
 * v1.4 — Server ball call, player registry, offline fallback
 * ES5 only. No arrow functions. No const/let. No backticks.
 *
 * CHANGES FROM v1.3:
 *   - getBallCall(cb): fetches server ball sequence via RPC,
 *     falls back to local CSPRNG if offline or RPC fails.
 *   - registerPlayer(cb): registers session → Player N in DB,
 *     falls back to local counter if offline.
 *   - refreshBallCall(): called when ball 75 exhausted,
 *     fetches new server sequence or generates locally.
 *   - isOnline(): live connectivity check used throughout.
 *   - All offline fallbacks are seamless — game never stalls.
 */

var SUPABASE_URL      = 'https://gdmmoeggkqsvqnqyrubx.supabase.co';
var SUPABASE_ANON_KEY = 'sb_publishable_NGsKBAUUsVUvD5XKTblIdw_aBDPldSd';

/* Per-game identity — set via inline script BEFORE this file loads */
var PROG_GAME_ID = (typeof PROG_GAME_ID !== 'undefined') ? PROG_GAME_ID : 'unknown';
var PROG_DENOM   = (typeof PROG_DENOM   !== 'undefined') ? PROG_DENOM   : 1.00;

/* Game title map for hit records */
var PROG_GAME_TITLES = {
  'straypups_1d': 'StrayPups Big Munny $1',
  'straypups_5d': 'StrayPups Big Munny $5',
  'turrelle':     'Turrelle Sisters',
  'unknown':      'Unknown Game'
};

var Progressive = (function () {

  /* ── Private state ── */
  var _client            = null;
  var _connected         = false;
  var _localValue        = 500.00;
  var _seed              = 500.00;
  var _ceiling           = 9999.00;
  var _contribRate       = 0.02;
  var _pendingAdd        = 0;
  var _flushTimer        = null;
  var _valueListeners    = [];
  var _presenceChannel   = null;
  var _presenceCount     = 0;
  var _presenceListeners = [];
  var _sessionKey        = 'sess_' + Math.random().toString(36).substr(2, 9);

  /* ── Player registry state ── */
  var _playerNum         = 0;     /* assigned after register_player RPC */
  var _playerLabel       = '';    /* "Player 3" — set after registration */
  var _playerNickname    = '';    /* player-chosen nickname */
  var _playerRegistered  = false;

  /* Ball pos update — debounced, max 1 write per 1.3s */
  var _ballPosTimer      = null;
  var _lastSentBallPos   = -1;

  /* ── LOCAL PROGRESSIVE (offline fallback) ── */
  var _localMode         = false;  /* true when offline, grows local pot */
  var _localPotValue     = 500.00; /* mirrors last known wide area value */
  var _localPotSeed      = 500.00; /* snapshot of seed when went offline */
  var _localPotCeiling   = 9999.00;/* mirrors wide area ceiling */
  var _connChangeListeners = [];   /* fired when online/offline state changes */
  var _connMonitorTimer  = null;

  /* ── Ball call state ── */
  var _serverBallCall    = null;  /* array of 75 numbers from DB, or null */
  var _usingServerBalls  = false; /* true when currently using server sequence */
  var _ballCallListeners = [];    /* callbacks when new sequence arrives */

  /* ── Force jackpot state ── */
  var _forceArmed        = false;
  var _forceCommandId    = null;
  var _forceClaimed      = false;
  var _onForceWin        = null;
  var _onForceNotify     = null;
  var _justWon           = false;

  /* ── Local fallback RNG (mirrors game.js RNG) ── */
  var _rng = (function() {
    var b = new Uint32Array(64); var i = 64;
    function fill() { crypto.getRandomValues(b); i = 0; }
    function next() { if (i >= b.length) fill(); return b[i++] / 0x100000000; }
    function int(lo, hi) { return Math.floor(next() * (hi - lo + 1)) + lo; }
    function shuffle(arr) {
      for (var j = arr.length - 1; j > 0; j--) {
        var k = int(0, j); var t = arr[j]; arr[j] = arr[k]; arr[k] = t;
      }
      return arr;
    }
    return { next: next, int: int, shuffle: shuffle };
  }());

  function _localBallShuffle() {
    var balls = [];
    for (var i = 1; i <= 75; i++) balls.push(i);
    return _rng.shuffle(balls);
  }

  /* ── Connectivity check ── */
  function _isOnline() {
    return _connected && _client !== null;
  }

  /* ═══════════════════════════════════════════════════════════════
     SDK LOADER
     ═══════════════════════════════════════════════════════════════ */
  function _loadSDK(cb) {
    if (typeof window !== 'undefined' && window.supabase) { cb(); return; }
    var s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.49.0/dist/umd/supabase.min.js';
    s.onload  = cb;
    s.onerror = function () {
      console.warn('[Progressive] SDK load failed — offline mode.');
      cb(); /* still call cb so game proceeds with local fallback */
    };
    document.head.appendChild(s);
  }

  /* ═══════════════════════════════════════════════════════════════
     NOTIFY HELPERS
     ═══════════════════════════════════════════════════════════════ */
  function _notifyValue() {
    var val = _localMode ? _localPotValue : _localValue;
    for (var i = 0; i < _valueListeners.length; i++) {
      try { _valueListeners[i](val); } catch (e) {}
    }
  }
  function _notifyPresence() {
    for (var i = 0; i < _presenceListeners.length; i++) {
      try { _presenceListeners[i](_presenceCount); } catch (e) {}
    }
  }
  function _notifyBallCall(seq) {
    for (var i = 0; i < _ballCallListeners.length; i++) {
      try { _ballCallListeners[i](seq); } catch (e) {}
    }
  }
  function _notifyConnChange(isOnline) {
    for (var i = 0; i < _connChangeListeners.length; i++) {
      try { _connChangeListeners[i](isOnline); } catch (e) {}
    }
  }

  /* ═══════════════════════════════════════════════════════════════
     BALL CALL — SERVER + OFFLINE FALLBACK
     ═══════════════════════════════════════════════════════════════ */

  /*
   * getBallCall(cb)
   * Fetches the current server ball sequence for this game_id.
   * cb(sequence, isServer) — sequence is array[75], isServer=true if from DB.
   * Falls back to local shuffle immediately if offline.
   * Timeout: if DB takes >3s, falls back locally and still delivers server
   * sequence asynchronously when it arrives (game is never stalled).
   */
  function getBallCall(cb) {
    if (!_isOnline()) {
      /* Offline — use local immediately */
      var local = _localBallShuffle();
      _usingServerBalls = false;
      if (cb) cb(local, false, 0);
      return;
    }

    var _timedOut = false;
    var _cbFired  = false;

    /* 3-second timeout — fall back locally, still await server async */
    var _timer = setTimeout(function () {
      if (_cbFired) return;
      _timedOut = true;
      console.warn('[Progressive] getBallCall timeout — using local fallback');
      var local = _localBallShuffle();
      _usingServerBalls = false;
      _cbFired = true;
      if (cb) cb(local, false, 0);
    }, 3000);

    _client.rpc('get_ball_call_with_pos', { p_game_id: PROG_GAME_ID })
      .then(function (res) {
        clearTimeout(_timer);
        if (res.error || !res.data || !res.data.sequence) {
          console.warn('[Progressive] getBallCall RPC error:', res.error && res.error.message);
          if (!_cbFired) {
            var local2 = _localBallShuffle();
            _usingServerBalls = false;
            _cbFired = true;
            if (cb) cb(local2, false, 0);
          }
          return;
        }
        _serverBallCall = res.data.sequence;
        var _serverBallPos = res.data.ball_pos || 0;
        _usingServerBalls = true;
        if (!_cbFired) {
          _cbFired = true;
          /* Pass sequence AND current ball position so joining player starts correctly */
          if (cb) cb(_serverBallCall.slice(), true, _serverBallPos);
        } else {
          _notifyBallCall(_serverBallCall.slice());
        }
      })
      .catch(function (err) {
        clearTimeout(_timer);
        console.warn('[Progressive] getBallCall catch:', err);
        if (!_cbFired) {
          var local3 = _localBallShuffle();
          _usingServerBalls = false;
          _cbFired = true;
          if (cb) cb(local3, false, 0);
        }
      });
  }

  /*
   * refreshBallCall(cb)
   * Called when ball 75 is exhausted. Gets a fresh server sequence.
   * Falls back to local if offline.
   */
  function refreshBallCall(cb) {
    if (!_isOnline()) {
      var local = _localBallShuffle();
      _usingServerBalls = false;
      if (cb) cb(local, false, 0);
      return;
    }

    _client.rpc('upsert_ball_call', { p_game_id: PROG_GAME_ID })
      .then(function (res) {
        if (res.error || !res.data || !Array.isArray(res.data)) {
          console.warn('[Progressive] refreshBallCall error — using local');
          var local2 = _localBallShuffle();
          _usingServerBalls = false;
          if (cb) cb(local2, false, 0);
          return;
        }
        _serverBallCall = res.data;
        _usingServerBalls = true;
        if (cb) cb(_serverBallCall.slice(), true);
      })
      .catch(function () {
        var local3 = _localBallShuffle();
        _usingServerBalls = false;
        if (cb) cb(local3, false, 0);
      });
  }

  /* ═══════════════════════════════════════════════════════════════
     PLAYER REGISTRATION
     ═══════════════════════════════════════════════════════════════ */

  /*
   * registerPlayer(cb)
   * Registers this session in player_registry and returns player_num.
   * cb(playerNum, playerLabel) — e.g. cb(3, "Player 3")
   * Falls back to local counter if offline.
   * Safe to call multiple times — only registers once per session.
   */
  var _localPlayerCounter = 1; /* shared local counter for offline sessions */

  function registerPlayer(cb, nickname) {
    if (nickname) _playerNickname = nickname;
    if (_playerRegistered) {
      /* Update nickname if changed */
      if (nickname && _client && _connected) {
        _client.rpc('register_player', {
          p_session_key: _sessionKey, p_game_id: PROG_GAME_ID,
          p_denom: PROG_DENOM, p_nickname: nickname
        });
      }
      if (cb) cb(_playerNum, _playerLabel);
      return;
    }

    if (!_isOnline()) {
      _playerNum       = _localPlayerCounter++;
      _playerLabel     = 'Player ' + _playerNum;
      _playerRegistered = true;
      console.warn('[Progressive] registerPlayer offline — assigned ' + _playerLabel + ' locally');
      if (cb) cb(_playerNum, _playerLabel);
      return;
    }

    /* 4-second timeout for registration */
    var _cbFired = false;
    var _timer = setTimeout(function () {
      if (_cbFired) return;
      _playerNum       = _localPlayerCounter++;
      _playerLabel     = 'Player ' + _playerNum + ' (local)';
      _playerRegistered = true;
      _cbFired = true;
      console.warn('[Progressive] registerPlayer timeout — using local label');
      if (cb) cb(_playerNum, _playerLabel);
    }, 4000);

    _client.rpc('register_player', {
      p_session_key: _sessionKey,
      p_game_id:     PROG_GAME_ID,
      p_denom:       PROG_DENOM,
      p_nickname:    _playerNickname || null
    }).then(function (res) {
      clearTimeout(_timer);
      if (_cbFired) return;
      if (res.error) {
        console.warn('[Progressive] register_player error:', res.error.message);
        _playerNum   = _localPlayerCounter++;
        _playerLabel = 'Player ' + _playerNum + ' (local)';
      } else {
        _playerNum   = res.data;
        _playerLabel = 'Player ' + _playerNum;
      }
      _playerRegistered = true;
      _cbFired = true;
      if (cb) cb(_playerNum, _playerLabel);
    }).catch(function (err) {
      clearTimeout(_timer);
      if (_cbFired) return;
      console.warn('[Progressive] registerPlayer catch:', err);
      _playerNum       = _localPlayerCounter++;
      _playerLabel     = 'Player ' + _playerNum + ' (local)';
      _playerRegistered = true;
      _cbFired = true;
      if (cb) cb(_playerNum, _playerLabel);
    });
  }

  /* ═══════════════════════════════════════════════════════════════
     DB FETCH
     ═══════════════════════════════════════════════════════════════ */
  function _fetchRow(cb) {
    if (!_client) { if (cb) cb(); return; }
    _client.from('progressive').select('*').eq('id', 1).single().then(function (res) {
      if (res.error) { if (cb) cb(); return; }
      var d = res.data;
      _localValue  = parseFloat(d.value)        || _seed;
      _seed        = parseFloat(d.seed)         || _seed;
      _ceiling     = parseFloat(d.ceiling)      || _ceiling;
      _contribRate = parseFloat(d.contrib_rate) || _contribRate;
      _notifyValue();
      if (cb) cb();
    });
  }

  function _checkArmedCommand() {
    if (!_client) return;
    _client.from('progressive_commands')
      .select('*').eq('status', 'armed').limit(1).then(function (res) {
        if (res.error || !res.data || !res.data.length) return;
        _forceArmed     = true;
        _forceCommandId = res.data[0].id;
      });
  }

  /* ═══════════════════════════════════════════════════════════════
     REALTIME
     ═══════════════════════════════════════════════════════════════ */
  function _subscribeValue() {
    _client.channel('prog-value')
      .on('postgres_changes', {
        event: 'UPDATE', schema: 'public', table: 'progressive', filter: 'id=eq.1'
      }, function (p) {
        if (!p.new) return;
        _localValue  = parseFloat(p.new.value)        || _localValue;
        _seed        = parseFloat(p.new.seed)         || _seed;
        _ceiling     = parseFloat(p.new.ceiling)      || _ceiling;
        _contribRate = parseFloat(p.new.contrib_rate) || _contribRate;
        _notifyValue();
      }).subscribe();
  }

  function _subscribeBallCall() {
    /* Listen for new server sequences issued by other sessions */
    _client.channel('prog-ball-call')
      .on('postgres_changes', {
        event: 'UPDATE', schema: 'public', table: 'ball_call',
        filter: 'game_id=eq.' + PROG_GAME_ID
      }, function (p) {
        if (!p.new || !p.new.sequence) return;
        var seq = p.new.sequence;
        if (!Array.isArray(seq)) return;
        _serverBallCall   = seq;
        _usingServerBalls = true;
        /* Notify game.js so it can adopt the new sequence seamlessly */
        _notifyBallCall(seq.slice());
      }).subscribe();
  }

  function _subscribeCommands() {
    _client.channel('prog-commands-' + _sessionKey.substr(0, 4))
      .on('postgres_changes', {
        event: 'INSERT', schema: 'public', table: 'progressive_commands'
      }, function (p) {
        if (!p.new || p.new.command !== 'force_jackpot' || p.new.status !== 'armed') return;
        _forceArmed     = true;
        _forceCommandId = p.new.id;
        _forceClaimed   = false;
      })
      .on('postgres_changes', {
        event: 'UPDATE', schema: 'public', table: 'progressive_commands'
      }, function (p) {
        if (!p.new || p.new.command !== 'force_jackpot') return;
        if (p.new.status === 'won' && p.new.winner_session !== _sessionKey) {
          _forceArmed     = false;
          _forceCommandId = null;
          if (_onForceNotify) {
            _onForceNotify(parseFloat(p.new.winner_amt) || 0, p.new.winner_game || 'another game');
          }
        }
      })
      .subscribe();
  }

  function _subscribeHits() {
    _client.channel('prog-hits-notify')
      .on('postgres_changes', {
        event: 'INSERT', schema: 'public', table: 'progressive_hits'
      }, function (p) {
        if (!p.new || _justWon) return;
        if (_onForceNotify) {
          _onForceNotify(parseFloat(p.new.amount) || 0, p.new.game_id || 'another game');
        }
      }).subscribe();
  }

  /* ═══════════════════════════════════════════════════════════════
     LOCAL PROGRESSIVE — OFFLINE FALLBACK
     When offline: pot mirrors last known wide area value, grows locally.
     Win pays from local pot, resets to last known seed. No DB writes.
     On reconnect: switches back to wide area instantly.
     ═══════════════════════════════════════════════════════════════ */

  function _goLocalMode() {
    if (_localMode) return;
    _localMode       = true;
    /* Snapshot current wide area values as local baseline */
    _localPotValue   = _localValue;
    _localPotSeed    = _seed;
    _localPotCeiling = _ceiling;
    console.warn('[Progressive] OFFLINE — switching to local progressive. Pot: $' + _localPotValue.toFixed(2));
    _notifyConnChange(false);
    _notifyValue(); /* re-notify with local value so meter updates */
  }

  function _goOnlineMode() {
    if (!_localMode) return;
    _localMode = false;
    console.log('[Progressive] ONLINE — resuming wide area progressive.');
    /* Re-fetch live value immediately */
    if (_client) _fetchRow(function() {
      _notifyValue();
      _notifyConnChange(true);
    });
  }

  function _startConnMonitor() {
    if (_connMonitorTimer) return;
    _connMonitorTimer = setInterval(function() {
      var nowConnected = (_connected && _client !== null);
      if (!nowConnected && !_localMode) {
        _goLocalMode();
      } else if (nowConnected && _localMode) {
        _goOnlineMode();
      }
    }, 2000);
    /* Also use browser online/offline events for instant detection */
    if (typeof window !== 'undefined') {
      window.addEventListener('offline', function() { if (!_localMode) _goLocalMode(); });
      window.addEventListener('online',  function() { setTimeout(function() { if (_localMode) _goOnlineMode(); }, 1000); });
    }
  }

  /* ═══════════════════════════════════════════════════════════════
     BALL POSITION TRACKING
     ═══════════════════════════════════════════════════════════════ */

  /*
   * updateBallPos(pos) — called by game every 1.3s via _activeCallNext.
   * Debounced — only writes to DB if pos changed and 1.3s elapsed.
   * Updates ball_call.ball_pos so joining players start at correct position.
   */
  function updateBallPos(pos) {
    if (!_connected || !_client) return;
    if (pos === _lastSentBallPos) return;
    _lastSentBallPos = pos;
    if (_ballPosTimer) return; /* debounce */
    _ballPosTimer = setTimeout(function() {
      _ballPosTimer = null;
      _client.rpc('update_ball_pos', {
        p_game_id: PROG_GAME_ID,
        p_pos:     _lastSentBallPos
      }).then(function(res) {
        if (res.error) console.warn('[Progressive] updateBallPos error:', res.error.message);
      });
    }, 300); /* 300ms debounce — safely under 1.3s interval */
  }

  /* ═══════════════════════════════════════════════════════════════
     PRESENCE
     ═══════════════════════════════════════════════════════════════ */
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
            gameId:      PROG_GAME_ID,
            denom:       PROG_DENOM,
            joinedAt:    new Date().toISOString(),
            playerLabel: _playerLabel || ('sess_' + _sessionKey.substr(0, 6)),
            nickname:    _playerNickname || _playerLabel || ('sess_' + _sessionKey.substr(0, 6)),
            sessionKey:  _sessionKey
          });
        }
      });
  }

  /* ═══════════════════════════════════════════════════════════════
     CONTRIBUTION FLUSH
     ═══════════════════════════════════════════════════════════════ */
  function _scheduleFlush() {
    if (_flushTimer) return;
    _flushTimer = setTimeout(function () {
      _flushTimer = null;
      if (_pendingAdd <= 0 || !_client || !_connected) return;
      var toAdd   = parseFloat(_pendingAdd.toFixed(4));
      _pendingAdd = 0;
      _client.rpc('progressive_contribute', { add_amount: toAdd }).then(function (res) {
        if (res.error) console.warn('[Progressive] contribute error:', res.error.message);
      });
    }, 5000);
  }

  /* ═══════════════════════════════════════════════════════════════
     FORCE WIN CLAIM (unchanged from v1.3)
     ═══════════════════════════════════════════════════════════════ */
  function _claimForceWin(onClaimed) {
    if (!_forceCommandId || _forceClaimed) { onClaimed(false); return; }
    _forceClaimed = true;
    var hitAmt    = parseFloat(_localValue.toFixed(2));

    var _safetyTimer = setTimeout(function () {
      _forceClaimed = false; _forceArmed = false; _forceCommandId = null;
      onClaimed(false);
    }, 8000);

    _client.from('progressive_commands')
      .update({
        status: 'won', winner_session: _sessionKey,
        winner_game: PROG_GAME_ID, winner_amt: hitAmt,
        won_at: new Date().toISOString()
      })
      .eq('id', _forceCommandId).eq('status', 'armed').select()
      .then(function (res) {
        if (res.error || !res.data || !res.data.length) {
          clearTimeout(_safetyTimer);
          _forceClaimed = false;
          onClaimed(false);
          return;
        }
        _client.rpc('progressive_hit', { reset_to: _seed }).then(function () {
          _client.from('progressive_hits').insert({
            game_id:        PROG_GAME_ID,
            denom:          PROG_DENOM,
            amount:         hitAmt,
            pattern:        'Force Jackpot',
            balls:          0,
            bet:            0,
            player_session: _sessionKey,
            player_label:   _playerLabel || _sessionKey,
            game_title:     PROG_GAME_TITLES[PROG_GAME_ID] || PROG_GAME_ID,
            win_patterns:   'Force Jackpot'
          });
          clearTimeout(_safetyTimer);
          _justWon = true;
          setTimeout(function () { _justWon = false; }, 5000);
          _localValue = _seed; _notifyValue();
          _forceArmed = false; _forceCommandId = null;
          onClaimed(true, hitAmt);
        }).catch(function () {
          clearTimeout(_safetyTimer);
          _justWon = true;
          setTimeout(function () { _justWon = false; }, 5000);
          _localValue = _seed; _notifyValue();
          _forceArmed = false; _forceCommandId = null;
          onClaimed(true, hitAmt);
        });
      }).catch(function () {
        clearTimeout(_safetyTimer);
        _forceClaimed = false;
        onClaimed(false);
      });
  }

  /* ═══════════════════════════════════════════════════════════════
     PUBLIC API
     ═══════════════════════════════════════════════════════════════ */

  function init(onReady) {
    _loadSDK(function () {
      if (!window.supabase) {
        /* SDK failed to load — full offline mode */
        console.warn('[Progressive] Full offline mode — no DB connection');
        _goLocalMode();
        _startConnMonitor();
        if (onReady) onReady();
        return;
      }
      try {
        _client    = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
        _connected = true;
        _fetchRow(function () {
          _subscribeValue();
          _subscribeCommands();
          _subscribeHits();
          _subscribePresence();
          _subscribeBallCall();
          _checkArmedCommand();
          _subscribeMessages();
          _checkUnreadMessages();
          setInterval(function () { _fetchRow(null); }, 60000);
          _startConnMonitor();
          if (onReady) onReady();
        });
      } catch (e) {
        console.warn('[Progressive] init failed:', e);
        _connected = false;
        _goLocalMode();
        if (onReady) onReady();
      }
    });
  }

  function contribute(betAmt) {
    if (!betAmt || betAmt <= 0) return false;
    var addition = betAmt * _contribRate;
    if (_localMode) {
      /* Offline — grow local pot only, no DB write */
      _localPotValue = Math.min(_localPotValue + addition, _localPotCeiling);
      _notifyValue(); /* meter shows local value */
      return false;   /* never armed when offline */
    }
    _localValue = Math.min(_localValue + addition, _ceiling);
    _notifyValue();
    if (_connected && _client) {
      _pendingAdd += addition;
      _scheduleFlush();
    }
    return _forceArmed;
  }

  function claimForce(onResult) { _claimForceWin(onResult); }

  function hit(info, onDone) {
    if (_localMode) {
      /* Offline local win — pay local pot, reset to local seed, no DB write */
      var hitAmt = parseFloat(_localPotValue.toFixed(2));
      _localPotValue = _localPotSeed;
      _notifyValue();
      console.log('[Progressive] LOCAL WIN: $' + hitAmt.toFixed(2) + ' — wide area pot unaffected');
      if (onDone) onDone(hitAmt);
      return hitAmt;
    }
    var hitAmt  = parseFloat(_localValue.toFixed(2));
    _localValue = _seed;
    _notifyValue();
    _justWon = true;
    setTimeout(function () { _justWon = false; }, 5000);

    var patternNames = (info && info.patterns)
      ? info.patterns.join(', ')
      : ((info && info.pattern) ? info.pattern : 'Progressive Jackpot');

    if (!_connected || !_client) {
      if (onDone) onDone(hitAmt);
      return hitAmt;
    }

    var rec = {
      game_id:        PROG_GAME_ID,
      denom:          PROG_DENOM,
      amount:         hitAmt,
      pattern:        (info && info.pattern) ? info.pattern : 'Progressive Jackpot',
      balls:          (info && info.balls)   ? info.balls   : 0,
      bet:            (info && info.bet)     ? info.bet     : 0,
      player_session: _sessionKey,
      player_label:   _playerLabel || _sessionKey,
      game_title:     PROG_GAME_TITLES[PROG_GAME_ID] || PROG_GAME_ID,
      win_patterns:   patternNames
    };

    var _hitSafety = onDone ? setTimeout(function () {
      console.warn('[Progressive] hit() DB timeout');
      if (onDone) { onDone(hitAmt); onDone = null; }
    }, 8000) : null;

    _client.rpc('progressive_hit', { reset_to: _seed })
      .then(function (rpcRes) {
        if (rpcRes.error) console.warn('[Progressive] hit RPC error:', rpcRes.error.message);
        _client.from('progressive_hits').insert(rec);
        setTimeout(function () { _fetchRow(null); }, 1000);
        if (_hitSafety) clearTimeout(_hitSafety);
        if (onDone) { onDone(hitAmt); onDone = null; }
      })
      .catch(function () {
        _client.from('progressive_hits').insert(rec);
        if (_hitSafety) clearTimeout(_hitSafety);
        if (onDone) { onDone(hitAmt); onDone = null; }
      });

    return hitAmt;
  }

  /* ═══════════════════════════════════════════════════════════════
     BROADCAST MESSAGES (unchanged from v1.3)
     ═══════════════════════════════════════════════════════════════ */
  var _messageListeners  = [];
  var _lastSeenMessageId = 0;
  var _SEEN_KEY          = 'prog_last_msg_' + PROG_GAME_ID;

  function _loadLastSeen() {
    try { var v = localStorage.getItem(_SEEN_KEY); if (v) _lastSeenMessageId = parseInt(v, 10) || 0; } catch(e) {}
  }
  function _saveLastSeen(id) {
    _lastSeenMessageId = id;
    try { localStorage.setItem(_SEEN_KEY, String(id)); } catch(e) {}
  }
  function _notifyMessage(msg) {
    for (var i = 0; i < _messageListeners.length; i++) {
      try { _messageListeners[i](msg); } catch(e) {}
    }
    _saveLastSeen(msg.id);
  }
  function _subscribeMessages() {
    _client.channel('broadcast-messages')
      .on('postgres_changes', {
        event: 'INSERT', schema: 'public', table: 'broadcast_messages'
      }, function(p) { if (p.new) _notifyMessage(p.new); })
      .subscribe();
  }
  function _checkUnreadMessages() {
    _loadLastSeen();
    _client.from('broadcast_messages').select('*')
      .gt('id', _lastSeenMessageId).order('id', { ascending: true })
      .then(function(res) {
        if (res.error || !res.data || !res.data.length) return;
        res.data.forEach(function(msg, i) {
          setTimeout(function() { _notifyMessage(msg); }, i * 4000);
        });
      });
  }

  /* ── Accessors ── */
  function mustHit()            { return _localMode ? (_localPotValue >= _localPotCeiling) : (_localValue >= _ceiling); }
  function getDisplay() {
    var v = _localMode ? _localPotValue : _localValue;
    var parts = v.toFixed(2).split('.');
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return '$' + parts[0] + '.' + parts[1];
  }
  function getValue()           { return _localMode ? _localPotValue : _localValue; }
  function isLocalMode()        { return _localMode; }
  function isConnected()        { return _connected; }
  function getPresenceCount()   { return _presenceCount; }
  function isForceArmed()       { return _forceArmed; }
  function getSessionKey()      { return _sessionKey; }
  function getPlayerNum()       { return _playerNum; }
  function getPlayerLabel()     { return _playerLabel; }
  function isUsingServerBalls() { return _usingServerBalls; }

  function onChange(fn)         { _valueListeners.push(fn); fn(_localValue); }
  function onPresenceChange(fn) { _presenceListeners.push(fn); fn(_presenceCount); }
  function onMessage(fn)        { _messageListeners.push(fn); }
  function onForceWin(fn)       { _onForceWin    = fn; }
  function onForceNotify(fn)    { _onForceNotify = fn; }
  function onBallCallUpdate(fn) { _ballCallListeners.push(fn); }

  return {
    init:               init,
    contribute:         contribute,
    claimForce:         claimForce,
    hit:                hit,
    getBallCall:        getBallCall,
    refreshBallCall:    refreshBallCall,
    registerPlayer:     registerPlayer,
    mustHit:            mustHit,
    getDisplay:         getDisplay,
    getValue:           getValue,
    isConnected:        isConnected,
    isForceArmed:       isForceArmed,
    getPresenceCount:   getPresenceCount,
    getSessionKey:      getSessionKey,
    getPlayerNickname:  function() { return _playerNickname; },
    isLocalMode:        isLocalMode,
    updateBallPos:      updateBallPos,
    getPlayerNum:       getPlayerNum,
    getPlayerLabel:     getPlayerLabel,
    isUsingServerBalls: isUsingServerBalls,
    onChange:           onChange,
    onPresenceChange:   onPresenceChange,
    onMessage:          onMessage,
    onForceWin:         onForceWin,
    onForceNotify:      onForceNotify,
    onBallCallUpdate:   onBallCallUpdate,
    onConnChange:       function(fn) { _connChangeListeners.push(fn); }
  };
}());
