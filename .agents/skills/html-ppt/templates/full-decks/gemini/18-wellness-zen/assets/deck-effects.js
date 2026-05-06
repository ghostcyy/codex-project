(function () {
  function runDeckEffects() {
    const canvas = document.getElementById('zen-canvas');
                const ctx = canvas.getContext('2d');
                canvas.width = window.innerWidth;
                canvas.height = window.innerHeight;

                const petals = [];
                const petalCount = 40;

                class Petal {
                    constructor() {
                        this.reset();
                    }
                    reset() {
                        this.x = Math.random() * canvas.width;
                        this.y = -10;
                        this.size = Math.random() * 8 + 5;
                        this.speedY = Math.random() * 1 + 0.5;
                        this.speedX = (Math.random() - 0.5) * 1;
                        this.angle = Math.random() * Math.PI * 2;
                        this.spin = Math.random() * 0.02 - 0.01;
                        this.opacity = Math.random() * 0.5 + 0.2;
                    }
                    update() {
                        this.y += this.speedY;
                        this.x += this.speedX;
                        this.angle += this.spin;
                        if (this.y > canvas.height) this.reset();
                    }
                    draw() {
                        ctx.save();
                        ctx.translate(this.x, this.y);
                        ctx.rotate(this.angle);
                        ctx.beginPath();
                        ctx.ellipse(0, 0, this.size, this.size / 2, 0, 0, Math.PI * 2);
                        ctx.fillStyle = `rgba(212, 163, 115, ${this.opacity})`;
                        ctx.fill();
                        ctx.restore();
                    }
                }

                for (let i = 0; i < petalCount; i++) petals.push(new Petal());

                function animateZen() {
                    ctx.clearRect(0, 0, canvas.width, canvas.height);
                    petals.forEach(p => {
                        p.update();
                        p.draw();
                    });
                    requestAnimationFrame(animateZen);
                }
                animateZen();

                // Charts
                Chart.defaults.color = '#a98467';
                Chart.defaults.font.family = "'Outfit', sans-serif";

                // 06 市场增长
                const ctxMarket = document.getElementById('marketLineChart');
                if (ctxMarket) {
                    new Chart(ctxMarket, {
                        type: 'line',
                        data: {
                            labels: ['2022', '2023', '2024', '2025', '2026'],
                            datasets: [{
                                label: 'Market Value (Trillion USD)',
                                data: [4.4, 4.8, 5.2, 5.9, 6.7],
                                borderColor: '#d4a373',
                                backgroundColor: 'rgba(212, 163, 115, 0.1)',
                                fill: true,
                                tension: 0.4,
                                pointRadius: 6,
                                pointBackgroundColor: '#fff'
                            }]
                        },
                        options: {
                            responsive: true,
                            maintainAspectRatio: false,
                            scales: { y: { grid: { color: 'rgba(0,0,0,0.03)' } }, x: { grid: { color: 'rgba(0,0,0,0.03)' } } }
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
