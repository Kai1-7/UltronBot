function formatDuration(value) {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    const hours = Math.floor(value / 3600);
    const minutes = Math.floor((value % 3600) / 60);
    const seconds = value % 60;

    if (hours > 0) {
      return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
    }

    return `${minutes}:${String(seconds).padStart(2, "0")}`;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed && trimmed !== "0:00" ? trimmed : "En vivo";
  }

  return "En vivo";
}

function trimForChoice(text) {
  return text.length > 100 ? `${text.slice(0, 97)}...` : text;
}

module.exports = {
  formatDuration,
  trimForChoice
};
