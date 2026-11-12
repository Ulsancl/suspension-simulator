function normalizeWindowState(value, area) {
  const saved = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const minWidth = Math.min(960, area.width), minHeight = Math.min(640, area.height);
  const dimension = (value, fallback, min, max) => Math.max(min, Math.min(max,
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : fallback));
  return {
    width: dimension(saved.width, 1440, minWidth, area.width),
    height: dimension(saved.height, 1000, minHeight, area.height),
    minWidth, minHeight, maximized: saved.maximized === true,
  };
}
module.exports = { normalizeWindowState };

