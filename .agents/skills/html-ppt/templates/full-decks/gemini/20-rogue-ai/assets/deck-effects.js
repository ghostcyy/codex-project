(function () {
  function runDeckEffects() {
    const canvas = document.getElementById('rogue-canvas');
                const ctx = canvas.getContext('2d');
                canvas.width = window.innerWidth;
                canvas.height = window.innerHeight;

                const hexes = [];
                const hexCount = 20;

                function drawHex(x, y, size) {
                    ctx.beginPath();
                    for (let i = 0; i < 6; i++) {
                        ctx.lineTo(x + size * Math.cos(i * Math.PI / 3), y + size * Math.sin(i * Math.PI / 3));
                    }
                    ctx.closePath();
                    ctx.strokeStyle = '#ff003c';
                    ctx.stroke();
                }

                class HexParticle {
                    constructor() {
                        this.reset();
                    }
                    reset() {
                        this.x = Math.random() * canvas.width;
                        this.y = Math.random() * canvas.height;
                        this.size = Math.random() * 50 + 20;
                        this.opacity = Math.random() * 0.5;
                        this.speed = Math.random() * 0.5 + 0.1;
                    }
                    update() {
                        this.opacity -= 0.002;
                        if (this.opacity <= 0) this.reset();
                    }
                    draw() {
                        ctx.globalAlpha = this.opacity;
                        drawHex(this.x, this.y, this.size);
                        ctx.globalAlpha = 1.0;
                    }
                }

                for (let i = 0; i < hexCount; i++) hexes.push(new HexParticle());

                function animateRogue() {
                    ctx.clearRect(0, 0, canvas.width, canvas.height);
                    hexes.forEach(h => {
                        h.update();
                        h.draw();
                    });
                    requestAnimationFrame(animateRogue);
                }
                animateRogue();

                // Charts
                Chart.defaults.color = '#666';
                Chart.defaults.font.family = "'JetBrains Mono', monospace";

                // 06 感染趋势
                const ctxInf = document.getElementById('infectionLineChart');
                if (ctxInf) {
                    new Chart(ctxInf, {
                        type: 'line',
                        data: {
                            labels: ['H-0', 'H-4', 'H-8', 'H-12'],
                            datasets: [{
                                label: 'Compromised Nodes (Log Scale)',
                                data: [1000, 1000000, 100000000, 42000000000],
                                borderColor: '#ff003c',
                                backgroundColor: 'rgba(255, 0, 60, 0.1)',
                                fill: true,
                                tension: 0.1,
                                pointRadius: 6
                            }]
                        },
                        options: {
                            responsive: true,
                            maintainAspectRatio: false,
                            scales: { y: { type: 'logarithmic', grid: { color: '#1a1a1a' } }, x: { grid: { color: '#1a1a1a' } } }
                        }
                    });
                }
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", runDeckEffects, { once: true });
  } else {
    runDeckEffects();
  }
})();
