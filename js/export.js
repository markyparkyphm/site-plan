// Composite the render canvas to a PNG and trigger a download
export function exportToPng(canvas, filename = 'site-plan.png') {
  const link = document.createElement('a');
  link.download = filename;
  link.href = canvas.toDataURL('image/png');
  link.click();
}
