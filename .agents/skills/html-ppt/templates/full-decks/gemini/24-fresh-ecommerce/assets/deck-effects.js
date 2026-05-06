(function () {
  function runDeckEffects() {
    const canvas = document.getElementById('fresh-canvas');
                if (canvas) {
                    const ctx = canvas.getContext('2d');
                    let blobs = [];
                    function resize() { canvas.width = window.innerWidth; canvas.height = window.innerHeight; }
                    window.addEventListener('resize', resize);
                    resize();

                    class Blob {
                        constructor() { this.init(); }
                        init() {
                            this.x = Math.random() * canvas.width;
                            this.y = Math.random() * canvas.height;
                            this.radius = Math.random() * 40 + 20;
                            this.color = Math.random() > 0.5 ? '#19beb8' : '#fcdfc5';
                            this.speedX = (Math.random() - 0.5) * 0.5;
                            this.speedY = (Math.random() - 0.5) * 0.5;
                            this.alpha = Math.random() * 0.3 + 0.1;
                        }
                        update() {
                            this.x += this.speedX;
                            this.y += this.speedY;
                            if (this.x < 0 || this.x > canvas.width) this.speedX *= -1;
                            if (this.y < 0 || this.y > canvas.height) this.speedY *= -1;
                        }
                        draw() {
                            ctx.beginPath();
                            ctx.arc(this.x, this.y, this.radius, 0, Math.PI * 2);
                            ctx.globalAlpha = this.alpha;
                            ctx.fillStyle = this.color;
                            ctx.fill();
                            ctx.globalAlpha = 1;
                        }
                    }
                    for (let i = 0; i < 15; i++) blobs.push(new Blob());
                    function animate() {
                        ctx.clearRect(0, 0, canvas.width, canvas.height);
                        blobs.forEach(b => { b.update(); b.draw(); });
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
