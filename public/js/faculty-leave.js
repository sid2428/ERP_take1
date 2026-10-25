// Progressive enhancement for Faculty Leave Management
(function () {
  'use strict';

  var fromInput = document.getElementById('fromDate');
  var toInput = document.getElementById('toDate');
  var daysInput = document.getElementById('daysRequested');

  if (!fromInput || !toInput || !daysInput) return;

  function updateDays() {
    if (!fromInput.value || !toInput.value) return;

    var start = new Date(fromInput.value);
    var end = new Date(toInput.value);

    if (end < start) {
      toInput.value = fromInput.value;
      end = new Date(fromInput.value);
    }

    var diffTime = end.getTime() - start.getTime();
    var diffDays = Math.round(diffTime / (1000 * 3600 * 24)) + 1;

    if (diffDays > 0) {
      daysInput.value = diffDays;
    }
  }

  fromInput.addEventListener('change', function () {
    if (fromInput.value) {
      toInput.min = fromInput.value;
      if (!toInput.value || toInput.value < fromInput.value) {
        toInput.value = fromInput.value;
      }
    }
    updateDays();
  });

  toInput.addEventListener('change', updateDays);
}());
