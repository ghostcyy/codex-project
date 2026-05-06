(function () {
  function runDeckEffects() {
    const canvas = document.getElementById('bokeh-canvas');
                const ctx = canvas.getContext('2d');
                canvas.width = window.innerWidth;
                canvas.height = window.innerHeight;

                const bokehs = [];
                const bokehCount = 30;

                class Bokeh {
                    constructor() {
                        this.reset();
                    }
                    reset() {
                        this.x = Math.random() * canvas.width;
                        this.y = Math.random() * canvas.height;
                        this.radius = Math.random() * 60 + 20;
                        this.opacity = Math.random() * 0.1 + 0.05;
                        this.speed = Math.random() * 0.3 + 0.1;
                    }
                    update() {
                        this.y -= this.speed;
                        if (this.y < -this.radius) this.reset();
                    }
                    draw() {
                        ctx.beginPath();
                        ctx.arc(this.x, this.y, this.radius, 0, Math.PI * 2);
                        ctx.fillStyle = `rgba(197, 160, 89, ${this.opacity})`;
                        ctx.fill();
                    }
                }

                for (let i = 0; i < bokehCount; i++) bokehs.push(new Bokeh());

                function animateBokeh() {
                    ctx.clearRect(0, 0, canvas.width, canvas.height);
                    bokehs.forEach(b => {
                        b.update();
                        b.draw();
                    });
                    requestAnimationFrame(animateBokeh);
                }
                animateBokeh();

                // Charts
                Chart.defaults.color = '#5d4037';
                Chart.defaults.font.family = "'Montserrat', sans-serif";

                // 06 材质趋势
                const ctxMat = document.getElementById('materialLineChart');
                if (ctxMat) {
                    new Chart(ctxMat, {
                        type: 'line',
                        data: {
                            labels: ['2022', '2023', '2024', '2025', '2026'],
                            datasets: [{
                                label: 'Sustainable Materials (%)',
                                data: [15, 28, 42, 60, 85],
                                borderColor: '#c5a059',
                                backgroundColor: 'rgba(197, 160, 89, 0.1)',
                                fill: true,
                                tension: 0.3,
                                pointRadius: 5
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
