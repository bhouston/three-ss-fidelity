"""Task contracts use mocked rendering and uploads; no GPU, Docker or cloud account."""
import contextlib
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch
sys.path.insert(0, str(Path(__file__).resolve().parent))
import dockergrid

class TaskTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(); self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name); (self.root / 'docker').mkdir()
        (self.root / 'docker' / 'scenes.json').write_text(json.dumps(['pt-gi-basic', 'pt-gi-other']))
        self.farm = Mock(params={}); self.outputs = []
        self.farm.output.side_effect = lambda file, mime, role: self.outputs.append((file.name, mime, role, file.read_bytes()))
    def render(self, command, **kwargs):
        if command[-1] == '--version' or 'check-hardware.mjs' in command[1]: return subprocess.CompletedProcess(command, 0)
        self.assertIn('--native', command)
        output = Path(command[command.index('--output') + 1]) / command[command.index('--scenes') + 1] / 'beauty'
        output.mkdir(parents=True); renderer = command[command.index('--renderers') + 1]
        (output / (renderer + '.avif')).write_bytes(b'image'); (output / 'sidecar.json').write_text('{}')
        return subprocess.CompletedProcess(command, 0)
    def test_default_cloud_contract_is_cpu_blender_with_fixed_sampling(self):
        description = dockergrid.describe(self.root)
        self.assertEqual(description['gpu'], 'none')
        self.assertEqual(description['inputSchema']['properties']['renderer']['enum'], ['blender'])
        scene, renderer, sampling = dockergrid.parameters({}, self.root)
        self.assertEqual((scene, renderer), ('pt-gi-basic', 'blender')); self.assertEqual(sampling['noise-threshold'], 0)
    def test_uploads_only_one_named_primary_image(self):
        with patch.object(dockergrid.subprocess, 'run', side_effect=self.render), contextlib.redirect_stdout(io.StringIO()): dockergrid.run_task(self.farm, self.root)
        self.assertEqual(self.outputs, [('pt-gi-basic.blender.avif', 'image/avif', 'primary', b'image')])
    def test_rejects_invalid_task_parameters_before_execution(self):
        for params in [{'scene': '*'}, {'scene': '../bad'}, {'renderer': 'all'}, {'samples': 0}, {'samples': True}, {'samples': 4097}, {'minSamples': 0}, {'noiseThreshold': float('nan')}, {'width': 32}]:
            with self.subTest(params=params), self.assertRaises(ValueError): dockergrid.parameters(params, self.root)
    def test_gpu_tasks_must_pass_the_hardware_guard_before_rendering(self):
        self.farm.params = {'renderer': 'three-gpu-pathtracer-webgpu-experimental'}
        with patch.object(dockergrid.subprocess, 'run', side_effect=subprocess.CalledProcessError(1, 'hardware')), contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaises(subprocess.CalledProcessError): dockergrid.run_task(self.farm, self.root)
        self.assertEqual(self.outputs, [])
    def test_missing_output_is_not_uploaded(self):
        with patch.object(dockergrid.subprocess, 'run'), contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaises(RuntimeError): dockergrid.run_task(self.farm, self.root)
        self.assertEqual(self.outputs, [])

if __name__ == '__main__': unittest.main()
