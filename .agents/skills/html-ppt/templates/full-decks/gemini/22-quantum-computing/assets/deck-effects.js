(function () {
  function runDeckEffects() {
    const canvas = document.getElementById('quantum-canvas');
                if (canvas) {
                    const ctx = canvas.getContext('2d');
                    let nodes = [];
                    function resize() { canvas.width = window.innerWidth; canvas.height = window.innerHeight; }
                    window.addEventListener('resize', resize);
                    resize();

                    class Node {
                        constructor() { this.init(); }
                        init() {
                            this.x = Math.random() * canvas.width;
                            this.y = Math.random() * canvas.height;
                            this.size = Math.random() * 3 + 1;
                            this.speedX = (Math.random() - 0.5) * 1;
                            this.speedY = (Math.random() - 0.5) * 1;
                            this.color = Math.random() > 0.5 ? '#00f2ff' : '#ff00d4';
                        }
                        update() {
                            this.x += this.speedX;
                            this.y += this.speedY;
                            if (this.x < 0 || this.x > canvas.width) this.speedX *= -1;
                            if (this.y < 0 || this.y > canvas.height) this.speedY *= -1;
                        }
                        draw() {
                            ctx.beginPath();
                            ctx.arc(this.x, this.y, this.size, 0, Math.PI * 2);
                            ctx.fillStyle = this.color;
                            ctx.shadowBlur = 10;
                            ctx.shadowColor = this.color;
                            ctx.fill();

                            // Entanglement lines
                            nodes.forEach(n => {
                                let dist = Math.sqrt((this.x - n.x)**2 + (this.y - n.y)**2);
                                if (dist < 150) {
                                    ctx.strokeStyle = this.color;
                                    ctx.globalAlpha = (150 - dist) / 600;
                                    ctx.lineWidth = 0.5;
                                    ctx.beginPath();
                                    ctx.moveTo(this.x, this.y);
                                    ctx.lineTo(n.x, n.y);
                                    ctx.stroke();
                                    ctx.globalAlpha = 1;
                                }
                            });
                        }
                    }
                    for (let i = 0; i < 40; i++) nodes.push(new Node());
                    function animate() {
                        ctx.clearRect(0, 0, canvas.width, canvas.height);
                        nodes.forEach(n => { n.update(); n.draw(); });
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
