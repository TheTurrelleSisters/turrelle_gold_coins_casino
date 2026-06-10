/* ================================================================
   progressive.js — Gold Coins Casino Progressive Operator v2.2
   FIXED: No longer creates its own Supabase client.
   Relies on _client created by index.html after PIN login.
   Exposes _op_* functions used by the UI.
   ================================================================ */

/* ── State ── */
var _armed = false;

/* ── Badge helper ── */
function _setBadge(ok) {
  var el = document.getElementById('conn-badge');
  if (!el) return;
  el.className   = ok ? 'ok'   : 'err';
  el.textContent = ok ? 'LIVE' : 'OFFLINE';
}

/* ── Display helpers ── */
function _updatePotDisplay(val, seed) {
  var v = Number(val  || 0).toFixed(2);
  var s = Number(seed || 0).toFixed(2);

  var potVal  = document.getElementById('pot-val');
  var ctrlPot = document.getElementById('ctrl-pot');
  var potSeed = document.getElementById('pot-seed');
  if (potVal)  potVal.textContent  = '$' + v;
  if (ctrlPot) ctrlPot.textContent = '$' + v;
  if (potSeed) potSeed.textContent = '$' + s;

  var upd = document.getElementById('pot-updated');
  if (upd) {
    upd.textContent = 'Updated ' + new Date().toLocaleTimeString();
  }

  var inp = document.getElementById('inp-seed');
  if (inp && document.activeElement !== inp) inp.value = s;
}

function _setArmed(armed) {
  _armed = armed;
  var banner = document.getElementById('armed-banner');
  if (banner) banner.classList.toggle('show', armed);
}

function _toast(msg) {
  var el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('on');
  setTimeout(function() { el.classList.remove('on'); }, 2500);
}

/* ── Guard: ensure _client is ready before any action ── */
function _getClient() {
  if (typeof _client !== 'undefined' && _client) return _client;
  _toast('Not connected — please wait');
  return null;
}

/* ══════════════════════════════════════════════════════════════════
   OPERATOR ACTIONS
   ══════════════════════════════════════════════════════════════════ */

/* ── Resolve a player label from the presence/ID maps built by index.html ── */
function _resolvePlayerLabel(sessionKey) {
  if (!sessionKey) return '—';
  /* _getPlayerLabel and _presenceState/_playerIdMap are defined in index.html */
  if (typeof _getPlayerLabel === 'function') return _getPlayerLabel(sessionKey);
  if (typeof _playerIdMap !== 'undefined' && _playerIdMap[sessionKey]) {
    return 'Player ' + _playerIdMap[sessionKey];
  }
  return sessionKey.substr(0, 8);
}

/* ── Find the active armed terminal session from presence state ──
   Returns { session, game_id, game_title, denom } or null if no
   active armed terminal can be identified.                        ── */
function _resolveWinnerSession() {
  if (typeof _presenceState === 'undefined') return null;
  var keys = Object.keys(_presenceState);
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i];
    var p = _presenceState[k];
    if (!p || p.gameId === 'operator') continue;
    /* Prefer the most-recently-spun terminal */
    return {
      session:    k,
      game_id:    p.gameId   || 'unknown',
      game_title: p.gameId   || 'Unknown Terminal',
      denom:      p.denom    || null
    };
  }
  return null;
}

window._op_saveSeed = function() {
  var sb = _getClient(); if (!sb) return;
  var val = parseFloat(document.getElementById('inp-seed').value);
  if (isNaN(val) || val < 0) return _toast('Invalid seed value');
  sb.from('progressive').update({ seed: val }).eq('id', 1)
    .then(function(r) {
      if (r.error) _toast('Error: ' + r.error.message);
      else _toast('Seed saved: $' + val.toFixed(2));
    });
};

window._op_arm = function() {
  var sb = _getClient(); if (!sb) return;
  if (_armed) return _toast('Already armed');
  if (!confirm('ARM the jackpot? Next eligible spin will trigger a payout.')) return;
  sb.from('progressive').update({ armed: true }).eq('id', 1)
    .then(function(r) {
      if (r.error) _toast('Error: ' + r.error.message);
      else { _setArmed(true); _toast('Jackpot ARMED'); }
    });
};

window._op_disarm = function() {
  var sb = _getClient(); if (!sb) return;
  sb.from('progressive').update({ armed: false }).eq('id', 1)
    .then(function(r) {
      if (r.error) _toast('Error: ' + r.error.message);
      else { _setArmed(false); _toast('Jackpot disarmed'); }
    });
};

window._op_setPot = function() {
  var sb = _getClient(); if (!sb) return;
  var val = parseFloat(document.getElementById('inp-override').value);
  if (isNaN(val) || val < 0) return _toast('Enter a valid amount');
  sb.from('progressive').update({ value: val }).eq('id', 1)
    .then(function(r) {
      if (r.error) _toast('Error: ' + r.error.message);
      else _toast('Pot set to $' + val.toFixed(2));
    });
};

window._op_trigger = function() {
  var sb = _getClient(); if (!sb) return;
  var potEl = document.getElementById('pot-val');
  var amt   = potEl ? parseFloat(potEl.textContent.replace('$', '')) : 0;
  if (isNaN(amt) || amt <= 0) return _toast('Invalid pot amount');
  var seed  = parseFloat(document.getElementById('inp-seed').value) || 500;
  if (!confirm('TRIGGER a jackpot hit of $' + amt.toFixed(2) + '?')) return;

  /* Step 1: insert hit record — all columns from progressive_hits schema.
     player_session / player_label pulled from whichever terminal is currently
     in the armed command (winner_session), or left as OPERATOR MANUAL if none. */
  var armedWinner = (typeof _presenceState !== 'undefined')
    ? _resolveWinnerSession() : null;

  sb.from('progressive_hits').insert({
    game_id:        armedWinner ? armedWinner.game_id   : 'operator',
    game_title:     armedWinner ? armedWinner.game_title : 'OPERATOR MANUAL',
    denom:          armedWinner ? armedWinner.denom      : null,
    amount:         amt,
    pattern:        'Operator Manual Trigger',
    balls:          0,
    bet:            0,
    player_session: armedWinner ? armedWinner.session   : null,
    player_label:   armedWinner ? _resolvePlayerLabel(armedWinner.session) : 'Operator',
    win_patterns:   'Operator Manual Trigger'
  })
  .then(function(r) {
    if (r.error) {
      _toast('Hit insert error: ' + r.error.message);
      return null; /* signal failure */
    }
    /* Step 2: reset pot */
    return sb.from('progressive').update({ value: seed, armed: false }).eq('id', 1);
  })
  .then(function(r) {
    if (r === null) return;
    if (r && r.error) _toast('Reset error: ' + r.error.message);
    else _toast('Jackpot triggered! Pot reset to $' + seed.toFixed(2));
  })
  .catch(function(err) {
    _toast('Trigger error: ' + (err.message || 'unknown'));
  });
};

window._op_sendMsg = function() {
  var sb = _getClient(); if (!sb) return;
  var msg  = (document.getElementById('msg-text').value || '').trim();
  var type = document.getElementById('msg-type').value || 'general';
  if (!msg) return _toast('Enter a message first');
  /* created_at omitted — Supabase DEFAULT now() handles it */
  sb.from('broadcast_messages').insert({ message: msg, type: type })
    .then(function(r) {
      if (r.error) _toast('Error: ' + r.error.message);
      else {
        _toast('Message broadcast!');
        document.getElementById('msg-text').value = '';
      }
    });
};

window._op_loadHist = function() {
  var sb = _getClient(); if (!sb) return;
  var list = document.getElementById('history-list');
  if (!list) return;
  list.innerHTML = '<div style="color:var(--dim);font-size:11px;text-align:center;padding:20px">Loading…</div>';
  sb.from('progressive_hits').select('*').order('created_at', { ascending: false }).limit(20)
    .then(function(r) {
      if (r.error) {
        list.innerHTML = '<div style="color:#ff4444;font-size:11px;text-align:center;padding:20px">Error: ' + r.error.message + '</div>';
        return;
      }
      if (!r.data || !r.data.length) {
        list.innerHTML = '<div style="color:var(--dim);font-size:11px;text-align:center;padding:20px">No hits recorded yet</div>';
        return;
      }
      list.innerHTML = r.data.map(function(h) {
        var d      = h.created_at ? new Date(h.created_at).toLocaleString() : '—';
        var player = h.player_label || (h.player_session ? _resolvePlayerLabel(h.player_session) : '—');
        var game   = h.game_title || h.game_id || 'Unknown';
        return '<div class="hit-row">' +
          '<div class="hit-game">'   + game   + '</div>' +
          '<div class="hit-player">' + player + '</div>' +
          '<div class="hit-amt">$'   + Number(h.amount || 0).toFixed(2) + '</div>' +
          '<div class="hit-meta">'   + d      + '</div>' +
          '</div>';
      }).join('');
    })
    .catch(function(err) {
      list.innerHTML = '<div style="color:#ff4444;font-size:11px;text-align:center;padding:20px">Error: ' + (err.message || 'unknown') + '</div>';
    });
};

window._op_loadStats = function() {
  var sb = _getClient(); if (!sb) return;
  sb.from('progressive_hits').select('amount')
    .then(function(r) {
      if (r.error || !r.data) return;
      var hits  = r.data.length;
      var total = r.data.reduce(function(a, h) { return a + Number(h.amount || 0); }, 0);
      var avg   = hits ? total / hits : 0;
      var max   = hits ? Math.max.apply(null, r.data.map(function(h) { return Number(h.amount || 0); })) : 0;
      var se = document.getElementById('stat-hits');  if (se) se.textContent = hits;
      var st = document.getElementById('stat-total'); if (st) st.textContent = '$' + total.toFixed(0);
      var sa = document.getElementById('stat-avg');   if (sa) sa.textContent = '$' + avg.toFixed(0);
      var sm = document.getElementById('stat-max');   if (sm) sm.textContent = '$' + max.toFixed(0);
    });
};
