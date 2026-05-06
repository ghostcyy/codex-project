(function () {
  function runDeckEffects() {
    const canvas = document.getElementById('outdoor-canvas');
                if (canvas) {
                    const ctx = canvas.getContext('2d');
                    function resize() { canvas.width = window.innerWidth; canvas.height = window.innerHeight; }
                    window.addEventListener('resize', resize);
                    resize();

                    let time = 0;
                    function drawTopography() {
                        ctx.clearRect(0, 0, canvas.width, canvas.height);
                        ctx.strokeStyle = 'rgba(152, 190, 44, 0.3)';
                        ctx.lineWidth = 1;

                        for (let j = 0; j < 5; j++) {
                            ctx.beginPath();
                            for (let i = 0; i < canvas.width; i += 10) {
                                const y = canvas.height * 0.5 +
                                          Math.sin(i * 0.005 + time + j) * 100 +
                                          Math.cos(i * 0.002 - time * 0.5) * 50;
                                if (i === 0) ctx.moveTo(i, y + j * 40);
                                else ctx.lineTo(i, y + j * 40);
                            }
                            ctx.stroke();
                        }
                        time += 0.005;
                        requestAnimationFrame(drawTopography);
                    }
                    drawTopography();
                }
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", runDeckEffects, { once: true });
  } else {
    runDeckEffects();
  }
})();
