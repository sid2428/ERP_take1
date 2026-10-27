document.addEventListener('click', (event) => {
  const target = event.target;
  if (target instanceof Element && target.closest('[data-action="print-payslip"]')) {
    window.print();
  }
});
