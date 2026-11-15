/* Small helpers for the dashboard pages. No framework, no build step. */
(function () {
  'use strict';

  var LABELS = { customer: 'Customer', bot: 'Assistant', staff: 'Team' };

  function bubble(message) {
    var node = document.createElement('div');
    node.className = 'bubble ' + message.sender + (message.status === 'failed' ? ' failed' : '');
    node.dataset.id = String(message.id);
    var lines = message.text === '' ? ['(no text)'] : message.text.split('\n');
    lines.forEach(function (line, i) {
      if (i > 0) node.appendChild(document.createElement('br'));
      node.appendChild(document.createTextNode(line));
    });
    var meta = document.createElement('span');
    meta.className = 'meta';
    var parts = [LABELS[message.sender] || message.sender, message.time];
    if (message.attachments > 0) parts.push('sent a photo, sticker or file');
    if (message.status === 'failed') parts.push('not sent: ' + (message.error || 'error'));
    if (message.status === 'pending') parts.push('sending');
    meta.textContent = parts.join(' \u00b7 ');
    node.appendChild(meta);
    return node;
  }

  // A chat that fills in new messages while the page is open.
  var chat = document.querySelector('[data-chat]');
  if (chat) {
    var thread = chat.dataset.chat;
    var last = Number(chat.dataset.last || 0);
    chat.scrollTop = chat.scrollHeight;

    var poll = function () {
      fetch('/api/conversations/' + encodeURIComponent(thread) + '/messages?after=' + last, {
        headers: { accept: 'application/json' },
      })
        .then(function (response) {
          if (response.status === 401) window.location.reload();
          return response.ok ? response.json() : { messages: [] };
        })
        .then(function (data) {
          var atBottom = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 80;
          data.messages.forEach(function (message) {
            var known = chat.querySelector('[data-id="' + message.id + '"]');
            var node = bubble(message);
            if (known) known.replaceWith(node);
            else chat.appendChild(node);
            if (message.status !== 'pending') last = Math.max(last, message.id);
          });
          var empty = chat.querySelector('.empty');
          if (empty && data.messages.length > 0) empty.remove();
          if (atBottom && data.messages.length > 0) chat.scrollTop = chat.scrollHeight;
        })
        .catch(function () {});
    };
    window.setInterval(poll, 2500);
  }

  // Lists reload themselves when something new has come in, unless someone is typing.
  var watched = document.querySelector('[data-watch]');
  if (watched) {
    var seen = watched.dataset.watch;
    window.setInterval(function () {
      var active = document.activeElement;
      if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) return;
      fetch('/api/summary', { headers: { accept: 'application/json' } })
        .then(function (response) {
          return response.ok ? response.json() : null;
        })
        .then(function (data) {
          if (data && data.signature !== seen) window.location.reload();
        })
        .catch(function () {});
    }, 8000);
  }

  // Enter sends, Shift+Enter starts a new line.
  document.querySelectorAll('textarea[data-enter-sends]').forEach(function (area) {
    area.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        if (area.value.trim() !== '') area.form.requestSubmit();
      }
    });
  });

  // The try-out chat sends without leaving the page.
  var tryForm = document.querySelector('form[data-try]');
  if (tryForm) {
    tryForm.addEventListener('submit', function (event) {
      event.preventDefault();
      var area = tryForm.querySelector('textarea');
      if (area.value.trim() === '') return;
      var body = new URLSearchParams(new FormData(tryForm)).toString();
      area.value = '';
      area.focus();
      fetch(tryForm.action, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body,
      }).catch(function () {});
    });
  }

  // Ask before a step that tells the customer something that cannot be taken back.
  document.querySelectorAll('form[data-confirm]').forEach(function (form) {
    form.addEventListener('submit', function (event) {
      if (!window.confirm(form.dataset.confirm)) event.preventDefault();
    });
  });
})();
