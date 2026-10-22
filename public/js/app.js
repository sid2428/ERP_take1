// Small progressive enhancements; every page works without JavaScript.
(function () {
  'use strict';
  var body = document.body;

  // mobile sidebar
  var menu = document.querySelector('[data-menu]');
  if (menu) {
    menu.addEventListener('click', function () {
      var open = body.classList.toggle('nav-open');
      menu.setAttribute('aria-expanded', String(open));
    });
    document.addEventListener('click', function (e) {
      if (body.classList.contains('nav-open') && !e.target.closest('.side') && !e.target.closest('[data-menu]')) {
        body.classList.remove('nav-open');
        menu.setAttribute('aria-expanded', 'false');
      }
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') body.classList.remove('nav-open');
    });
  }

  // confirmation before destructive actions: <form data-confirm="Are you sure?">
  document.querySelectorAll('form[data-confirm]').forEach(function (form) {
    form.addEventListener('submit', function (e) {
      if (!window.confirm(form.getAttribute('data-confirm'))) e.preventDefault();
    });
  });

  // filter dropdowns submit their form immediately
  document.querySelectorAll('select[data-autosubmit]').forEach(function (select) {
    select.addEventListener('change', function () { select.form.submit(); });
  });

  // close the account menu when clicking elsewhere
  document.addEventListener('click', function (e) {
    document.querySelectorAll('details.me-menu[open]').forEach(function (d) {
      if (!d.contains(e.target)) d.removeAttribute('open');
    });
  });

  // Keep the server-backed bell and an open notice board current across tabs/devices.
  // The endpoint is recipient-scoped; polling pauses while hidden and never overlaps.
  var notificationLink = document.querySelector('.notification-link');
  if (notificationLink && window.fetch) {
    var lastRevision = notificationLink.getAttribute('data-notification-revision') || '';
    var inFlight = false;
    var timer = null;

    function renderUnread(unread) {
      var count = Number(unread);
      if (!Number.isFinite(count) || count < 0) count = 0;
      count = Math.floor(count);
      var badge = notificationLink.querySelector('.notification-badge');
      if (count > 0) {
        if (!badge) {
          badge = document.createElement('span');
          badge.className = 'notification-badge';
          badge.setAttribute('aria-hidden', 'true');
          notificationLink.appendChild(badge);
        }
        badge.textContent = count > 99 ? '99+' : String(count);
      } else if (badge) {
        badge.remove();
      }
      var unreadText = count ? ', ' + count + ' unread' : ', no unread notifications';
      notificationLink.setAttribute('aria-label', 'Notifications' + unreadText);
      notificationLink.title = 'Notifications' + (count ? ', ' + count + ' unread' : '');
      notificationLink.setAttribute('data-notification-unread', String(count));
    }

    function refreshNotifications() {
      if (inFlight || document.visibilityState === 'hidden') return;
      inFlight = true;
      fetch('/api/notifications/state', {
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { Accept: 'application/json' }
      }).then(function (response) {
        if (response.status === 401) {
          lastRevision = '';
          renderUnread(0);
          return null;
        }
        if (!response.ok) throw new Error('notification state unavailable');
        return response.json();
      }).then(function (state) {
        if (!state || typeof state.revision !== 'string') return;
        var changed = state.revision !== lastRevision;
        lastRevision = state.revision;
        renderUnread(state.unread);
        if (changed && document.querySelector('[data-notification-board]')) window.location.reload();
      }).catch(function () {
        // A transient network/session error must not disturb the last known badge.
      }).then(function () {
        inFlight = false;
      });
    }

    function startPolling() {
      if (!timer) timer = window.setInterval(refreshNotifications, 15000);
    }
    function stopPolling() {
      if (timer) window.clearInterval(timer);
      timer = null;
    }
    refreshNotifications();
    startPolling();
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') {
        refreshNotifications();
        startPolling();
      } else {
        stopPolling();
      }
    });
    window.addEventListener('focus', refreshNotifications);
    window.addEventListener('pagehide', stopPolling);
    window.addEventListener('pageshow', function () {
      if (document.visibilityState === 'visible') {
        refreshNotifications();
        startPolling();
      }
    });
  }
})();
