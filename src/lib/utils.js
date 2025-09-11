

module.exports.cleanRow = function (row) {
  const cleaned = {};
  Object.entries(row).forEach(([key, value]) => {
    if (typeof value === 'string') {
      value = value.trim();
      value = value.replace(/\r/g, '');
      value = value.replace(/^'|'$/g, ''); // Remove Excel quotes
    }
    cleaned[key] = value;
  });
  return cleaned;
}