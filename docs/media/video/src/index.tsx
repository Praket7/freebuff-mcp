import React from 'react';
import { AbsoluteFill, Composition, Easing, interpolate, registerRoot, useCurrentFrame, useVideoConfig } from 'remotion';

const Card = ({ title, detail, x, delay, active }: { title: string; detail: string; x: number; delay: number; active: boolean }) => {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [delay, delay + 14], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.out(Easing.cubic) });
  const scale = interpolate(frame, [delay, delay + 14], [0.94, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.out(Easing.cubic) });
  return <div style={{ position: 'absolute', left: x, top: 230, width: 390, height: 300, borderRadius: 28, padding: 34, boxSizing: 'border-box', opacity, scale, background: active ? '#192e3a' : '#f4f1e8', color: active ? '#f4f1e8' : '#172632', border: active ? '2px solid #59d8d7' : 'none', boxShadow: '0 24px 70px #0005' }}>
    <div style={{ fontSize: 18, letterSpacing: 2, color: active ? '#67e0dc' : '#d36f54', fontWeight: 700 }}>{active ? 'LOCAL BRIDGE' : 'FREEBUFF MCP'}</div>
    <div style={{ marginTop: 28, fontSize: 36, fontWeight: 700 }}>{title}</div>
    <div style={{ marginTop: 18, fontSize: 22, lineHeight: 1.45, color: active ? '#b9cbd0' : '#465963' }}>{detail}</div>
  </div>;
};

const Scene = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const titleOpacity = interpolate(frame, [0, 16], [0, 1], { extrapolateRight: 'clamp' });
  const progress = interpolate(frame, [2 * fps, 9 * fps], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  return <AbsoluteFill style={{ background: 'linear-gradient(135deg,#101827,#1c3445)', fontFamily: 'Arial,sans-serif', color: '#f4f1e8' }}>
    <div style={{ position: 'absolute', top: 68, left: 100, opacity: titleOpacity, fontSize: 54, fontWeight: 700 }}>Freebuff MCP</div>
    <div style={{ position: 'absolute', top: 138, left: 104, opacity: titleOpacity, color: '#a8c0c7', fontSize: 25 }}>A clear path from your MCP app to Freebuff on your computer</div>
    <Card title="MCP app" detail="Send a harmless request from Codex, Claude Code, or another compatible app." x={95} delay={12} active={false} />
    <Card title="Local bridge" detail="Keep one session, show each progress event, and pass stop requests to the owning backend." x={605} delay={40} active />
    <Card title="Desktop or CLI" detail="Work stays on your computer. Freebuff keeps its own sign in and approval steps." x={1115} delay={70} active={false} />
    <div style={{ position: 'absolute', top: 385, left: 480, width: 125, height: 4, background: '#59d8d7', transformOrigin: 'left', scaleX: progress }} />
    <div style={{ position: 'absolute', top: 385, left: 995, width: 120, height: 4, background: '#59d8d7', transformOrigin: 'left', scaleX: progress }} />
    <div style={{ position: 'absolute', top: 620, left: 110, width: 1375, height: 100, borderRadius: 22, background: '#14252f', border: '1px solid #31505a' }}>
      {['Request', 'Progress', 'Approval', 'Complete'].map((label, i) => {
        const x = 50 + i * 430;
        const reached = progress >= i / 3;
        return <React.Fragment key={label}><div style={{ position: 'absolute', left: x, top: 36, color: reached ? '#b2f3df' : '#839aa2', fontSize: 22 }}>{label}</div>{i < 3 && <div style={{ position: 'absolute', left: x + 130, top: 47, width: 260, height: 3, background: progress >= (i + 1) / 3 ? '#59d8d7' : '#36505a' }} />}</React.Fragment>;
      })}
    </div>
    <div style={{ position: 'absolute', left: 105, bottom: 42, color: '#93aeb7', fontSize: 19 }}>Synthetic product illustration · automated checks are separate from live Desktop or CLI acceptance</div>
  </AbsoluteFill>;
};

const Root = () => <Composition id="FreebuffExplainer" component={Scene} durationInFrames={360} fps={30} width={1600} height={900} />;
registerRoot(Root);
