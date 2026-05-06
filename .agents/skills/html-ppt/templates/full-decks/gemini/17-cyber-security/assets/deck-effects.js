(function () {
  function runDeckEffects() {
    const canvas = document.getElementById('matrix-canvas');
                const ctx = canvas.getContext('2d');
                canvas.width = window.innerWidth;
                canvas.height = window.innerHeight;

                const particles = [];
                const particleCount = 80;
                const maxDistance = 150;

                class Particle {
                    constructor() {
                        this.x = Math.random() * canvas.width;
                        this.y = Math.random() * canvas.height;
                        this.vx = (Math.random() - 0.5) * 0.5;
                        this.vy = (Math.random() - 0.5) * 0.5;
                        this.radius = Math.random() * 2 + 1;
                    }
                    update() {
                        this.x += this.vx;
                        this.y += this.vy;
                        if (this.x < 0 || this.x > canvas.width) this.vx *= -1;
                        if (this.y < 0 || this.y > canvas.height) this.vy *= -1;
                    }
                    draw() {
                        ctx.beginPath();
                        ctx.arc(this.x, this.y, this.radius, 0, Math.PI * 2);
                        ctx.fillStyle = 'rgba(0, 242, 255, 0.5)';
                        ctx.fill();
                    }
                }

                for (let i = 0; i < particleCount; i++) {
                    particles.push(new Particle());
                }

                function animate() {
                    ctx.clearRect(0, 0, canvas.width, canvas.height);
                    for (let i = 0; i < particles.length; i++) {
                        const p1 = particles[i];
                        p1.update();
                        p1.draw();
                        for (let j = i + 1; j < particles.length; j++) {
                            const p2 = particles[j];
                            const dx = p1.x - p2.x;
                            const dy = p1.y - p2.y;
                            const dist = Math.sqrt(dx * dx + dy * dy);
                            if (dist < maxDistance) {
                                ctx.beginPath();
                                ctx.strokeStyle = `rgba(0, 242, 255, ${1 - dist / maxDistance})`;
                                ctx.lineWidth = 0.5;
                                ctx.moveTo(p1.x, p1.y);
                                ctx.lineTo(p2.x, p2.y);
                                ctx.stroke();
                            }
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", runDeckEffects, { once: true });
  } else {
    runDeckEffects();
  }
})();
