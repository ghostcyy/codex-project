export function getNavRuntimeScript(): string {
  return `<script data-html-ppt-v3-nav-runtime>
(() => {
  if (window.__htmlPptV3NavRuntimeInstalled) return;
  window.__htmlPptV3NavRuntimeInstalled = true;

  let slides = [];
  let currentIndex = 0;
  let progressFill = null;

  function collectSlides() {
    slides = Array.from(document.querySelectorAll("section.slide"));
    slides.forEach((slide, index) => {
      slide.setAttribute("data-html-ppt-v3-index", String(index));
      if (!slide.hasAttribute("tabindex")) slide.setAttribute("tabindex", "-1");
    });
    if (currentIndex >= slides.length) currentIndex = Math.max(0, slides.length - 1);
    return slides;
  }

  function ensureProgressBar() {
    let bar = document.querySelector(".progress-bar");
    if (!bar) {
      bar = document.createElement("div");
      bar.className = "progress-bar";
      bar.setAttribute("aria-hidden", "true");
      bar.setAttribute("data-html-ppt-v3-progress", "true");
      bar.appendChild(document.createElement("span"));
      document.body.appendChild(bar);
    }
    progressFill = bar.querySelector("span");
    if (!progressFill) {
      progressFill = document.createElement("span");
      bar.appendChild(progressFill);
    }
    return progressFill;
  }

  function updateProgress() {
    const fill = ensureProgressBar();
    const percent = slides.length ? ((currentIndex + 1) / slides.length) * 100 : 0;
    fill.style.width = percent + "%";
  }

  function postState() {
    window.parent?.postMessage({
      type: "html-ppt-v3:state",
      currentIndex,
      totalSlides: slides.length
    }, "*");
  }

  function activateSlide(index) {
    collectSlides();
    if (slides.length === 0) {
      currentIndex = 0;
      updateProgress();
      postState();
      return;
    }
    currentIndex = Math.min(Math.max(index, 0), slides.length - 1);
    slides.forEach((slide, slideIndex) => {
      const isCurrent = slideIndex === currentIndex;
      slide.classList.toggle("is-active", isCurrent);
      slide.setAttribute("aria-hidden", isCurrent ? "false" : "true");
    });
    slides[currentIndex].scrollIntoView({ behavior: "auto", block: "start", inline: "nearest" });
    updateProgress();
    postState();
  }

  function navigate(direction) {
    if (direction === "prev") {
      activateSlide(currentIndex - 1);
      return;
    }
    if (direction === "next") {
      activateSlide(currentIndex + 1);
      return;
    }
    if (typeof direction === "number" && Number.isFinite(direction)) {
      activateSlide(direction);
    }
  }

  window.addEventListener("message", (event) => {
    const data = event.data;
    if (!data || typeof data !== "object") return;
    if (data.type === "html-ppt-v3:navigate") navigate(data.direction);
    if (data.type === "html-ppt-v3:goto" && typeof data.index === "number") activateSlide(data.index);
  });

  window.addEventListener("keydown", (event) => {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      navigate("prev");
    }
    if (event.key === "ArrowRight" || event.key === " ") {
      event.preventDefault();
      navigate("next");
    }
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => activateSlide(currentIndex), { once: true });
  } else {
    activateSlide(currentIndex);
  }
})();
</script>`;
}
