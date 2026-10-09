import { mountRenderHost } from 'fidelity-kit/browser/host';
// Canvas2D only: verifies live UI, sizing and session lifecycle without a software 3D renderer.
void mountRenderHost(async (params, reporter, host) => {
  const canvas = document.createElement('canvas');
  canvas.width = Number(params.width ?? 320);
  canvas.height = Number(params.height ?? 240);
  host.append(canvas);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas2D unavailable');
  const draw = () => {
    context.fillStyle = '#123456';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#fedc34';
    context.fillRect(canvas.width / 4, canvas.height / 4, canvas.width / 2, canvas.height / 2);
  };
  draw();
  reporter.ready();
  return {
    canvas,
    draw,
    async complete() {},
    resize(width, height) {
      canvas.width = width;
      canvas.height = height;
      draw();
    },
    dispose() {
      canvas.remove();
    },
  };
}).catch(() => {});
