"use client";

import { useEffect, useRef } from "react";

export function ParticlesBg() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let animationFrameId: number;
    let mouse = { x: -1000, y: -1000, rightClickDown: false, active: false };

    const handleMouseMove = (e: MouseEvent) => {
      mouse.x = e.clientX;
      mouse.y = e.clientY;
      
      // 边界检测：如果鼠标靠近屏幕边缘（30px以内），直接关闭吸引力
      // 这能彻底解决鼠标移出到滚动条或系统UI时粒子仍被吸引聚集的问题
      const margin = 5;
      if (
        e.clientX < margin || 
        e.clientX > window.innerWidth - margin || 
        e.clientY < margin || 
        e.clientY > window.innerHeight - margin
      ) {
        mouse.active = false;
      } else {
        mouse.active = true;
      }
    };

    const handleMouseDown = (e: MouseEvent) => {
      if (e.button === 2) {
        mouse.rightClickDown = true;
      } else if (e.button === 0) {
        shockwaves.push({ x: e.clientX, y: e.clientY, age: 0 });
      }
    };

    const handleMouseUp = (e: MouseEvent) => {
      if (e.button === 2) {
        mouse.rightClickDown = false;
      }
    };

    const handleContextMenu = (e: MouseEvent) => {
      e.preventDefault(); 
    };

    const handleMouseLeave = () => {
      mouse.x = -1000;
      mouse.y = -1000;
      mouse.rightClickDown = false;
      mouse.active = false;
    };

    const handleMouseOut = (e: MouseEvent) => {
      // If relatedTarget is null, the mouse completely left the browser document/window
      if (!e.relatedTarget) {
        handleMouseLeave();
      }
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mousedown", handleMouseDown);
    window.addEventListener("mouseup", handleMouseUp);
    window.addEventListener("contextmenu", handleContextMenu);
    document.addEventListener("mouseout", handleMouseOut);
    document.documentElement.addEventListener("mouseleave", handleMouseLeave);
    window.addEventListener("blur", handleMouseLeave);

    let particles: { x: number; y: number; s: number; driftVx: number; driftVy: number; attrVx: number; attrVy: number; }[] = [];
    let shockwaves: { x: number; y: number; age: number; }[] = [];

    const resize = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
      initParticles();
    };

    const initParticles = () => {
      particles = [];
      const particleCount = Math.floor((canvas.width * canvas.height) / 9000); 
      for (let i = 0; i < particleCount; i++) {
        particles.push({
          x: Math.random() * canvas.width,
          y: Math.random() * canvas.height,
          s: Math.random() * 0.6 + 1.4, // 大小更加均匀集中
          driftVx: (Math.random() - 0.5) * 0.6,
          driftVy: (Math.random() - 0.5) * 0.6,
          attrVx: 0,
          attrVy: 0
        });
      }
    };

    let time = 0;

    const draw = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      
      time += 0.3; // 统一颜色随时间推移缓慢变化
      const hue = time % 360;
      const fillColor = `hsla(${hue}, 80%, 65%, 0.8)`;

      // 处理和渲染左键冲击波扩散影响
      for (let i = shockwaves.length - 1; i >= 0; i--) {
        const sw = shockwaves[i];
        if (!sw) {
          continue;
        }

        sw.age += 1;

        const maxAge = 35; // 冲击波存活帧数
        const waveRadius = sw.age * 22; // 冲击波每帧扩散半径

        // 渲染一层微妙的物理冲击波光圈
        ctx.beginPath();
        ctx.arc(sw.x, sw.y, waveRadius, 0, Math.PI * 2);
        ctx.strokeStyle = `hsla(${hue}, 80%, 65%, ${0.4 * (1 - sw.age / maxAge)})`;
        ctx.lineWidth = 3;
        ctx.stroke();

        for (const p of particles) {
          const dx = p.x - sw.x;
          const dy = p.y - sw.y;
          const dist = Math.sqrt(dx * dx + dy * dy);

          // 核心优化：只要粒子处于冲击波圆圈内部，就会持续受到向外排斥（解决残余死角漏网之鱼）
          if (dist < waveRadius && dist > 1) {
            // 距离圆环边缘越近受力越大，中心受力越小，形成平滑的潮水推行感
            const solidForce = dist / waveRadius;
            // 爆发力参数由 10.0 大幅削弱至 2.5，总体效果减半且更加柔和
            const explodeStrength = 2.5 * (1 - sw.age / maxAge); 

            if (explodeStrength > 0) {
              p.attrVx += (dx / dist) * solidForce * explodeStrength;
              p.attrVy += (dy / dist) * solidForce * explodeStrength;
            }
          }
        }

        if (sw.age >= maxAge) {
          shockwaves.splice(i, 1);
        }
      }

      for (const p of particles) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.s, 0, Math.PI * 2);
        ctx.fillStyle = fillColor;
        ctx.fill();

        const dx = mouse.x - p.x;
        const dy = mouse.y - p.y;
        const distance = Math.sqrt(dx * dx + dy * dy);
        
        // 当右键时：范围 500px，吸力 0.4
        // 当平时移动时：增加范围到 350px，吸力提升到 0.10
        const maxDistance = mouse.rightClickDown ? 500 : 350;
        const pullStrength = mouse.rightClickDown ? 0.4 : 0.10;

        if (mouse.active && distance < maxDistance) {
          const force = (maxDistance - distance) / maxDistance;
          // 累加计算吸引向鼠标的速度
          p.attrVx += (dx / distance) * force * pullStrength;
          p.attrVy += (dy / distance) * force * pullStrength;
        }

        // 使用空气阻力法则消除高频抖动：
        // 距离越近，刹车越猛。离开吸附区缓慢减速。这样自然飘逸又不会在中心爆震。
        if (distance < 20) {
          p.attrVx *= 0.6; // 核心区极强阻尼（消除抖动点）
          p.attrVy *= 0.6;
        } else {
          p.attrVx *= 0.92; // 默认游走过程阻尼
          p.attrVy *= 0.92;
        }

        // 我们将原生漂浮(driftV)与鼠标推力(attrV)相加运算，各自独立
        p.x += p.driftVx + p.attrVx;
        p.y += p.driftVy + p.attrVy;

        // 平滑边缘穿透边界
        if (p.x < -10) p.x = canvas.width + 10;
        else if (p.x > canvas.width + 10) p.x = -10;
        
        if (p.y < -10) p.y = canvas.height + 10;
        else if (p.y > canvas.height + 10) p.y = -10;
      }

      animationFrameId = requestAnimationFrame(draw);
    };

    window.addEventListener("resize", resize);
    resize();
    draw();

    return () => {
      window.removeEventListener("resize", resize);
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mousedown", handleMouseDown);
      window.removeEventListener("mouseup", handleMouseUp);
      window.removeEventListener("contextmenu", handleContextMenu);
      document.removeEventListener("mouseout", handleMouseOut);
      document.documentElement.removeEventListener("mouseleave", handleMouseLeave);
      window.removeEventListener("blur", handleMouseLeave);
      cancelAnimationFrame(animationFrameId);
    };
  }, []);

  return (
    <canvas 
      ref={canvasRef} 
      className="fixed inset-0 pointer-events-none -z-10"
      style={{ width: "100%", height: "100%" }}
    />
  );
}
