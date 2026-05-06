(function () {
  function runDeckEffects() {
    const canvas = document.getElementById('ocean-particles');
                if (canvas) {
                    const ctx = canvas.getContext('2d');
                    let particles = [];
                    function resize() { canvas.width = window.innerWidth; canvas.height = window.innerHeight; }
                    window.addEventListener('resize', resize);
                    resize();

                    class Particle {
                        constructor() { this.init(); }
                        init() {
                            this.x = Math.random() * canvas.width;
                            this.y = canvas.height + Math.random() * 100;
                            this.size = Math.random() * 5 + 1;
                            this.speedY = Math.random() * -2 - 1;
                            this.opacity = Math.random() * 0.5 + 0.1;
                        }
                        update() {
                            this.y += this.speedY;
                            if (this.y < -50) this.init();
                        }
                        draw() {
                            ctx.beginPath();
                            ctx.arc(this.x, this.y, this.size, 0, Math.PI * 2);
                            ctx.fillStyle = `rgba(129, 212, 250, ${this.opacity})`;
                            ctx.fill();
                        }
                    }
                    for (let i = 0; i < 60; i++) particles.push(new Particle());
                    function animate() {
                        ctx.clearRect(0, 0, canvas.width, canvas.height);
                        particles.forEach(p => { p.update(); p.draw(); });
                        requestAnimationFrame(animate);
                    }
                    animate();
                }
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", runDeckEffects, { once: true });
  } else {
    runDeckEffects();
  }
})();
