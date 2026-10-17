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
})();
