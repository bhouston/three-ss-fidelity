export function requireHardwareGPU(description: string): void {
  if (
    !description.trim() ||
    /swiftshader|llvmpipe|lavapipe|softpipe|software|basic render|\bwarp\b|\bcpu\b/i.test(description)
  ) {
    throw new Error(
      'Rendering verification blocked: a real hardware GPU is required (' +
        (description || 'adapter unavailable') +
        ')',
    );
  }
}
