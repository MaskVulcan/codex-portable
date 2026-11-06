"""Public builds must not silently embed credentials left on the build machine."""
from contextlib import redirect_stdout
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('prepare', ROOT / 'scripts' / 'prepare.py')
prepare = importlib.util.module_from_spec(spec)
spec.loader.exec_module(prepare)


class PublicBuildTest(unittest.TestCase):
    def test_default_build_ignores_old_private_payload_and_machine_credentials(self):
        with tempfile.TemporaryDirectory() as temporary:
            payload = Path(temporary)
            (payload / 'provisioning.json').write_text('{"apiKey":"OLD_PRIVATE_TOKEN"}')
            with patch.object(prepare, 'PAYLOAD', payload), patch.object(Path, 'home', side_effect=AssertionError('Do not read home credentials')):
                with redirect_stdout(io.StringIO()):
                    prepare.provision()
            settings = json.loads((payload / 'provisioning.json').read_text())
            self.assertEqual(settings['apiKey'], '')
            self.assertTrue(all(p['apiKey'] == '' for p in settings['profiles']))
            self.assertEqual([p['name'] for p in settings['profiles']], ['axhan', '4router'])

    def test_private_build_uses_selected_profile_without_logging_token(self):
        with tempfile.TemporaryDirectory() as temporary:
            payload = Path(temporary)
            settings = json.loads((ROOT / 'config' / 'provisioning.example.json').read_text())
            settings['activeProfileId'] = '4router-core'
            settings['profiles'][1]['apiKey'] = 'SYNTHETIC_PRIVATE_TOKEN'
            source = payload / 'source.json'
            source.write_text(json.dumps(settings))
            output = io.StringIO()
            with patch.object(prepare, 'PAYLOAD', payload), redirect_stdout(output):
                prepare.provision(source)
            result = json.loads((payload / 'provisioning.json').read_text())
            self.assertEqual(result['apiKey'], 'SYNTHETIC_PRIVATE_TOKEN')
            self.assertEqual(result['baseUrl'], settings['profiles'][1]['baseUrl'])
            self.assertNotIn('SYNTHETIC_PRIVATE_TOKEN', output.getvalue())


if __name__ == '__main__':
    unittest.main()
