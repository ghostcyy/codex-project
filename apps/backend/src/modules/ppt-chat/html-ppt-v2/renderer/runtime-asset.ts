export const HTML_PPT_V2_RUNTIME_JS = String.raw`
(() => {
  const deck = document.querySelector(".deck");
  if (!deck) return;
  const slides = Array.from(deck.querySelectorAll(".slide"));
  const progress = deck.querySelector(".deck-progress-bar");
  const status = deck.querySelector(".deck-status");
  let index = Math.max(0, slides.findIndex((slide) => slide.classList.contains("is-active")));

  function activate(nextIndex) {
    if (!slides.length) return;
    index = Math.max(0, Math.min(slides.length - 1, nextIndex));
    slides.forEach((slide, offset) => {
      slide.classList.toggle("is-active", offset === index);
      slide.setAttribute("aria-hidden", offset === index ? "false" : "true");
    });
    if (progress) {
      progress.style.setProperty("--progress", String(((index + 1) / slides.length) * 100) + "%");
    }
    if (status) {
      status.textContent = String(index + 1) + " / " + String(slides.length);
    }
  }

  document.addEventListener("keydown", (event) => {
    if (event.key === "ArrowRight" || event.key === "PageDown" || event.key === " ") {
      event.preventDefault();
      activate(index + 1);
    }
    if (event.key === "ArrowLeft" || event.key === "PageUp") {
      event.preventDefault();
      activate(index - 1);
    }
    if (event.key === "Home") {
      event.preventDefault();
      activate(0);
    }
    if (event.key === "End") {
      event.preventDefault();
      activate(slides.length - 1);
    }
  });

  window.htmlPptV2 = { activateSlide: activate, slideCount: slides.length };
  activate(index);
})();
`.trim();
