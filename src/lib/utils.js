

module.exports.cleanRow = function (row) {
  const cleaned = {};
  Object.entries(row).forEach(([key, value]) => {
    if (typeof value === 'string') {
      value = value.trim();
      value = value.replace(/\r/g, ''); // Remove carriage returns
    }
    cleaned[key] = value;
  });
  return cleaned;
}