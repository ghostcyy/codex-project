(function () {
  function runDeckEffects() {
    const canvas = document.getElementById('home-canvas');
                if (canvas) {
                    const ctx = canvas.getContext('2d');
                    let dots = [];
                    function resize() { canvas.width = window.innerWidth; canvas.height = window.innerHeight; }
                    window.addEventListener('resize', resize);
                    resize();

                    class Dot {
                        constructor() { this.init(); }
                        init() {
                            this.x = Math.random() * canvas.width;
                            this.y = -10;
                            this.size = Math.random() * 8 + 4;
                            this.color = ['#a8d5ba', '#fff3c7', '#f87171', '#cbd5e1'][Math.floor(Math.random() * 4)];
                            this.speedY = Math.random() * 1.5 + 0.5;
                            this.angle = Math.random() * Math.PI * 2;
                            this.spin = Math.random() * 0.1 - 0.05;
                        }
                        update() {
                            this.y += this.speedY;
                            this.angle += this.spin;
                            if (this.y > canvas.height) this.init();
                        }
                        draw() {
                            ctx.save();
                            ctx.translate(this.x, this.y);
                            ctx.rotate(this.angle);
                            ctx.fillStyle = this.color;
                            ctx.globalAlpha = 0.4;
                            ctx.fillRect(-this.size/2, -this.size/2, this.size, this.size);
                            ctx.restore();
                        }
                    }
                    for (let i = 0; i < 40; i++) dots.push(new Dot());
                    function animate() {
                        ctx.clearRect(0, 0, canvas.width, canvas.height);
                        dots.forEach(d => { d.update(); d.draw(); });
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
