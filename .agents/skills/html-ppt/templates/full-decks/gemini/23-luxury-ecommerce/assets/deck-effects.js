(function () {
  function runDeckEffects() {
    const canvas = document.getElementById('luxury-canvas');
                if (canvas) {
                    const ctx = canvas.getContext('2d');
                    let sparks = [];
                    function resize() { canvas.width = window.innerWidth; canvas.height = window.innerHeight; }
                    window.addEventListener('resize', resize);
                    resize();

                    class Spark {
                        constructor() { this.init(); }
                        init() {
                            this.x = Math.random() * canvas.width;
                            this.y = Math.random() * canvas.height;
                            this.size = Math.random() * 2 + 0.5;
                            this.speedX = (Math.random() - 0.5) * 0.3;
                            this.speedY = Math.random() * 0.5 + 0.2;
                            this.alpha = Math.random() * 0.6 + 0.1;
                            this.blink = Math.random() * 0.02 + 0.005;
                        }
                        update() {
                            this.y += this.speedY;
                            this.x += this.speedX;
                            this.alpha -= this.blink;
                            if (this.y > canvas.height || this.alpha <= 0) this.init();
                        }
                        draw() {
                            ctx.beginPath();
                            ctx.arc(this.x, this.y, this.size, 0, Math.PI * 2);
                            ctx.fillStyle = `rgba(212, 175, 55, ${this.alpha})`;
                            ctx.fill();
                        }
                    }
                    for (let i = 0; i < 80; i++) sparks.push(new Spark());
                    function animate() {
                        ctx.clearRect(0, 0, canvas.width, canvas.height);
                        sparks.forEach(s => { s.update(); s.draw(); });
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
