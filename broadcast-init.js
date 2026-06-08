/*
 * broadcast-init.js — Broadcast Messages + Progressive Notifications
 * v1.0 — Drop-in file for all game repos
 * 
 * Wires Progressive.onMessage() for operator broadcasts
 * Wires Progressive.onForceNotify() for force jackpot notifications
 *
 * INSTALLATION:
 * 1. Drop this file into the game's root folder (same level as progressive.js)
 * 2. Add this ONE line to index.html immediately after the <script> that loads progressive.js:
 *    <script src="broadcast-init.js?v=1.0"></script>
 *
 * That's it. No other changes needed.
 *
 * ES5 only. No const/let/arrow functions/backticks.
 */

(function () {

  /* ─── Persistent broadcast toast (operator announcements) ─────────────────── */
  function showBroadcastToast(body, title) {
    var DURATION_MS = 12000;  // Show for 12 seconds
    var el = document.getElementById('broadcast-toast');

    if (!el) {
      el = document.createElement('div');
      el.id = 'broadcast-toast';
      el.style.cssText = [
        'position:fixed',
        'bottom:90px',
        'left:50%',
        'transform:translateX(-50%)',
        'background:rgba(10,10,30,0.96)',
        'color:#ffd700',
        'border:2px solid #ffd700',
        'border-radius:10px',
        'padding:14px 20px',
        'max-width:88vw',
        'width:340px',
        'font-size:14px',
        'line-height:1.45',
        'text-align:center',
        'z-index:9999',
        'box-shadow:0 4px 24px rgba(0,0,0,0.85)',
        'cursor:pointer',
        'font-family:Arial,sans-serif',
        'display:none'
      ].join(';');
      document.body.appendChild(el);
    }

    var html = '';
    if (title) {
      html += '<div style="font-weight:bold;font-size:15px;margin-bottom:6px;">'
            + escapeHtml(title) + '</div>';
    }
    html += '<div>' + escapeHtml(body) + '</div>';
    html += '<div style="margin-top:8px;font-size:11px;color:#aaa;">(tap to dismiss)</div>';
    el.innerHTML = html;
    el.style.display = 'block';

    el.onclick = function () {
      clearTimeout(el._timer);
      el.style.display = 'none';
    };

    clearTimeout(el._timer);
    el._timer = setTimeout(function () {
      el.style.display = 'none';
    }, DURATION_MS);
  }

  /* ─── Escape HTML to prevent injection ──────────────────────────────────── */
  function escapeHtml(text) {
    if (!text) return '';
    var map = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#039;'
    };
    return String(text).replace(/[&<>"']/g, function(c) { return map[c]; });
  }

  /* ─── Wait for Progressive, then wire both handlers ──────────────────────── */
  function wireProgressiveHandlers() {
    if (typeof Progressive === 'undefined') {
      /* progressive.js not loaded yet — retry in 200ms */
      setTimeout(wireProgressiveHandlers, 200);
      return;
    }

    /* ─ Handler 1: Operator broadcast messages ─ */
    if (typeof Progressive.onMessage === 'function') {
      Progressive.onMessage(function (msg) {
        if (!msg || !msg.message) return;
        showBroadcastToast(msg.message, msg.title || '');
      });
    }

    /* ─ Handler 2: Force jackpot notifications (another game won) ─ */
    if (typeof Progressive.onForceNotify === 'function') {
      Progressive.onForceNotify(function (amt, gameId) {
        var label = gameId && gameId !== 'unknown' ? gameId : 'another player';
        var text = '\u2605 JACKPOT HIT on ' + label + '! $' + (amt || 0).toFixed(2);
        
        /* Try game's native toast first (if available), else use broadcast overlay */
        if (typeof UI !== 'undefined' && typeof UI.showToast === 'function') {
          UI.showToast(text, 5000);
        } else if (typeof toast === 'function') {
          toast(text);
        } else {
          showBroadcastToast(text, '');
        }
      });
    }

    console.log('[broadcast-init] Wired Progressive.onMessage and onForceNotify');
  }

  /* Start wiring as soon as this script executes */
  wireProgressiveHandlers();

}());
