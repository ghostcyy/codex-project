export function getNavRuntimeScript(): string {
  return `<script data-html-ppt-v3-nav-runtime>
(() => {
  if (window.__htmlPptV3NavRuntimeInstalled) return;
  window.__htmlPptV3NavRuntimeInstalled = true;

  let slides = [];
  let currentIndex = 0;
  let progressFill = null;
  let presenterWindow = null;
  const previewMatch = /[?&]preview=(\\d+)/.exec(window.location.search || "");
  const initialPreviewIndex = previewMatch ? Math.max(0, Number(previewMatch[1]) - 1) : -1;
  const isPreviewMode = initialPreviewIndex >= 0;
  const channelName = "html-ppt-v3-presenter:" + window.location.pathname;
  let channel = null;
  try {
    channel = new BroadcastChannel(channelName);
  } catch (_error) {
    channel = null;
  }

  function collectSlides() {
    slides = Array.from(document.querySelectorAll("section.slide"));
    slides.forEach((slide, index) => {
      slide.setAttribute("data-html-ppt-v3-index", String(index));
      if (!slide.hasAttribute("tabindex")) slide.setAttribute("tabindex", "-1");
    });
    if (currentIndex >= slides.length) currentIndex = Math.max(0, slides.length - 1);
    return slides;
  }

  function isEditingText() {
    const active = document.activeElement;
    if (active && active.closest && active.closest("[contenteditable='true']")) return true;
    if (document.body?.classList.contains("ppt-edit-mode")) return true;
    if (document.documentElement?.classList.contains("ppt-edit-mode")) return true;
    return false;
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

  function updateSlideNumbers() {
    slides.forEach((slide, index) => {
      slide.setAttribute("data-slide-index", String(index + 1));
      slide.setAttribute("data-slide-total", String(slides.length));
      slide.querySelectorAll(".slide-number").forEach((numberEl) => {
        numberEl.setAttribute("data-current", String(index + 1));
        numberEl.setAttribute("data-total", String(slides.length));
      });
    });
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

  function postPresenterState() {
    if (!channel) return;
    try {
      channel.postMessage({ type: "go", index: currentIndex });
    } catch (_error) {}
  }

  function activateSlide(index, options = {}) {
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
      slide.classList.toggle("is-prev", slideIndex < currentIndex);
      slide.setAttribute("aria-hidden", isCurrent ? "false" : "true");
      if (isPreviewMode) {
        slide.style.display = isCurrent ? "" : "none";
        if (isCurrent) {
          slide.style.opacity = "1";
          slide.style.transform = "none";
          slide.style.pointerEvents = "auto";
        }
      }
    });
    updateSlideNumbers();
    if (!isPreviewMode) {
      slides[currentIndex].scrollIntoView({ behavior: "auto", block: "start", inline: "nearest" });
    }
    updateProgress();
    postState();
    if (!isPreviewMode && !options.fromRemote) postPresenterState();
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

  function getSlideTitle(slide, index) {
    return (slide.getAttribute("data-title") || slide.querySelector("h1,h2,h3")?.textContent || "Slide " + (index + 1)).trim();
  }

  function getSlideNotes(slide) {
    const notes = slide.querySelector(".notes, aside.notes, .speaker-notes");
    return notes ? notes.innerHTML : "";
  }

  function getDeckUrl() {
    return window.location.origin
      ? window.location.origin + window.location.pathname
      : window.location.href.replace(/[?#].*$/, "");
  }

  function buildPresenterHtml(startIndex) {
    const meta = slides.map((slide, index) => ({
      title: getSlideTitle(slide, index),
      notes: getSlideNotes(slide)
    }));
    const payload = JSON.stringify({
      channelName,
      deckUrl: getDeckUrl(),
      startIndex,
      totalSlides: slides.length,
      slides: meta
    }).replace(/</g, "\\\\u003c");

    return "<!doctype html>" +
      "<html lang=\\"zh-CN\\"><head><meta charset=\\"utf-8\\"><title>Presenter View</title>" +
      "<style>" +
      "*{box-sizing:border-box}body{margin:0;height:100vh;background:#141820;color:#edf2f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Noto Sans SC',sans-serif;overflow:hidden}" +
      ".presenter{height:100vh;display:grid;grid-template-columns:2fr 1fr;grid-template-rows:1.35fr 1fr;gap:12px;padding:12px 12px 40px}" +
      ".card{background:#0b1018;border:1px solid rgba(255,255,255,.12);border-radius:14px;overflow:hidden;box-shadow:0 18px 48px rgba(0,0,0,.35)}" +
      ".head{height:36px;display:flex;align-items:center;justify-content:space-between;padding:0 12px;border-bottom:1px solid rgba(255,255,255,.08);font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:#9aa4b2;font-weight:800}" +
      ".body{height:calc(100% - 36px);position:relative;overflow:hidden}.preview iframe{position:absolute;left:0;top:0;width:1920px;height:1080px;border:0;transform-origin:top left;background:#000}" +
      ".notes .body{padding:16px;overflow:auto;font-size:16px;line-height:1.62}.notes .empty{color:#6b7280;font-style:italic}" +
      ".timer .body{padding:18px;display:flex;flex-direction:column;justify-content:center;gap:14px}.clock{font:800 46px/1 'SF Mono',Consolas,monospace;color:#33d17a}.count{font:700 18px/1 'SF Mono',Consolas,monospace}.buttons{display:flex;gap:8px;flex-wrap:wrap}button{border:1px solid rgba(255,255,255,.16);border-radius:999px;background:rgba(255,255,255,.08);color:#fff;padding:8px 14px;font-weight:800;cursor:pointer}" +
      ".hint{position:fixed;left:0;right:0;bottom:0;height:32px;display:flex;align-items:center;gap:18px;padding:0 14px;background:rgba(0,0,0,.55);color:#9aa4b2;font-size:12px}kbd{background:rgba(255,255,255,.12);padding:2px 6px;border-radius:5px;color:#fff}" +
      "</style></head><body>" +
      "<div class=\\"presenter\\">" +
      "<div class=\\"card preview\\"><div class=\\"head\\"><span>Current</span><span id=\\"curMeta\\"></span></div><div class=\\"body\\"><iframe id=\\"curFrame\\"></iframe></div></div>" +
      "<div class=\\"card preview\\"><div class=\\"head\\"><span>Next</span><span id=\\"nextMeta\\"></span></div><div class=\\"body\\"><iframe id=\\"nextFrame\\"></iframe></div></div>" +
      "<div class=\\"card notes\\"><div class=\\"head\\"><span>Speaker Script · 逐字稿</span></div><div class=\\"body\\" id=\\"notesBody\\"></div></div>" +
      "<div class=\\"card timer\\"><div class=\\"head\\"><span>Timer</span></div><div class=\\"body\\"><div class=\\"clock\\" id=\\"clock\\">00:00</div><div class=\\"count\\" id=\\"count\\"></div><div class=\\"buttons\\"><button id=\\"prevBtn\\">← Prev</button><button id=\\"nextBtn\\">Next →</button><button id=\\"resetBtn\\">Reset</button></div></div></div>" +
      "</div><div class=\\"hint\\"><span><kbd>← →</kbd> 翻页</span><span><kbd>R</kbd> 重置计时</span><span><kbd>Esc</kbd> 关闭</span></div>" +
      "<script>window.__HTML_PPT_V3_PRESENTER__=" + payload + ";(function(){var cfg=window.__HTML_PPT_V3_PRESENTER__;var idx=cfg.startIndex||0;var started=Date.now();var bc=null;try{bc=new BroadcastChannel(cfg.channelName)}catch(e){}var cur=document.getElementById('curFrame');var next=document.getElementById('nextFrame');var notes=document.getElementById('notesBody');var curMeta=document.getElementById('curMeta');var nextMeta=document.getElementById('nextMeta');var clock=document.getElementById('clock');var count=document.getElementById('count');function scale(f){var body=f.parentElement;var s=Math.min(body.clientWidth/1920,body.clientHeight/1080);f.style.transform='scale('+s+')';f.style.left=Math.max(0,(body.clientWidth-1920*s)/2)+'px';f.style.top=Math.max(0,(body.clientHeight-1080*s)/2)+'px'}function post(f,n){try{f.contentWindow.postMessage({type:'html-ppt-v3:preview-goto',index:n},'*');f.contentWindow.postMessage({type:'preview-goto',idx:n},'*')}catch(e){}}function update(n,remote){idx=Math.max(0,Math.min(cfg.totalSlides-1,n));curMeta.textContent=(idx+1)+'/'+cfg.totalSlides;nextMeta.textContent=idx+1<cfg.totalSlides?(idx+2)+'/'+cfg.totalSlides:'END';notes.innerHTML=cfg.slides[idx].notes||'<span class=\\"empty\\">（这一页还没有逐字稿）</span>';count.textContent=(idx+1)+' / '+cfg.totalSlides;post(cur,idx);if(idx+1<cfg.totalSlides){next.style.display='';post(next,idx+1)}else{next.style.display='none'}scale(cur);scale(next);if(!remote&&bc)bc.postMessage({type:'go',index:idx})}function go(n){update(n,false)}function reset(){started=Date.now();clock.textContent='00:00'}setInterval(function(){var s=Math.floor((Date.now()-started)/1000);clock.textContent=String(Math.floor(s/60)).padStart(2,'0')+':'+String(s%60).padStart(2,'0')},1000);if(bc)bc.onmessage=function(e){if(e.data&&e.data.type==='go')update(Number(e.data.index),true)};window.addEventListener('resize',function(){scale(cur);scale(next)});document.getElementById('prevBtn').onclick=function(){go(idx-1)};document.getElementById('nextBtn').onclick=function(){go(idx+1)};document.getElementById('resetBtn').onclick=reset;document.addEventListener('keydown',function(e){if(e.ctrlKey||e.metaKey||e.altKey)return;if(e.key==='ArrowRight'||e.key===' '||e.key==='PageDown'){e.preventDefault();go(idx+1)}else if(e.key==='ArrowLeft'||e.key==='PageUp'){e.preventDefault();go(idx-1)}else if(e.key==='r'||e.key==='R'){reset()}else if(e.key==='Escape'){window.close()}});cur.onload=function(){scale(cur);post(cur,idx)};next.onload=function(){scale(next);post(next,idx+1)};cur.src=cfg.deckUrl+'?preview='+(idx+1);if(idx+1<cfg.totalSlides)next.src=cfg.deckUrl+'?preview='+(idx+2);update(idx,true)})();</" + "script>" +
      "</body></html>";
  }

  function openPresenter() {
    collectSlides();
    if (presenterWindow && !presenterWindow.closed) {
      presenterWindow.focus();
      return;
    }
    presenterWindow = window.open("", "html-ppt-v3-presenter", "width=1280,height=820,menubar=no,toolbar=no");
    if (!presenterWindow) {
      window.alert("请允许弹出窗口以使用演讲者视图");
      return;
    }
    presenterWindow.document.open();
    presenterWindow.document.write(buildPresenterHtml(currentIndex));
    presenterWindow.document.close();
  }

  if (channel) {
    channel.onmessage = (event) => {
      const data = event.data;
      if (!data || data.type !== "go") return;
      const nextIndex = typeof data.index === "number" ? data.index : data.idx;
      if (typeof nextIndex === "number") activateSlide(nextIndex, { fromRemote: true });
    };
  }

  window.addEventListener("message", (event) => {
    const data = event.data;
    if (!data || typeof data !== "object") return;
    if (data.type === "html-ppt-v3:navigate") navigate(data.direction);
    if (data.type === "html-ppt-v3:goto" && typeof data.index === "number") activateSlide(data.index);
    if ((data.type === "html-ppt-v3:preview-goto" && typeof data.index === "number") || (data.type === "preview-goto" && typeof data.idx === "number")) {
      activateSlide(typeof data.index === "number" ? data.index : data.idx, { fromRemote: true });
    }
  });

  window.addEventListener("keydown", (event) => {
    if (event.ctrlKey || event.metaKey || event.altKey || isEditingText()) return;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      navigate("prev");
    }
    if (event.key === "ArrowRight" || event.key === " ") {
      event.preventDefault();
      navigate("next");
    }
    if (event.key === "s" || event.key === "S") {
      event.preventDefault();
      openPresenter();
    }
  });

  function init() {
    collectSlides();
    if (isPreviewMode) {
      document.documentElement.setAttribute("data-preview", "1");
      document.body.setAttribute("data-preview", "1");
      document.querySelectorAll(".progress-bar, .notes-overlay, .overview, .notes, aside.notes, .speaker-notes").forEach((element) => {
        element.style.display = "none";
      });
      activateSlide(Math.min(initialPreviewIndex, Math.max(0, slides.length - 1)), { fromRemote: true });
      try {
        window.parent?.postMessage({ type: "preview-ready" }, "*");
      } catch (_error) {}
      return;
    }
    activateSlide(currentIndex);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
</script>`;
}
