from __future__ import annotations

import base64
import json
import os
import sys
import tempfile
import unittest
import zipfile
from argparse import Namespace
from pathlib import Path
from unittest import mock

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))

from collect_artifacts import is_android_release_bundle  # noqa: E402
from configure_android_signing import escape_java_property, main as configure_android_signing_main  # noqa: E402
from prepare_project import ProjectError, inject_runtime, read_and_write_manifest, safe_extract, safe_member_path, validate_metadata  # noqa: E402


class ProjectValidationTests(unittest.TestCase):
    def test_accepts_normal_virtual_project_paths(self):
        self.assertEqual(safe_member_path("src/main.js"), ("src/main.js", False))
        self.assertEqual(safe_member_path("assets/"), ("assets", True))

    def test_rejects_paths_that_can_escape_or_alias(self):
        for path in ("../outside.txt", "/etc/passwd", "C:/Windows/a", "assets\\..\\secret", "a//b", "a/../b", "CON.txt"):
            with self.subTest(path=path), self.assertRaises(ProjectError):
                safe_member_path(path)

    def test_validates_package_identifier_and_version(self):
        good = validate_metadata("My App", "com.example.myapp", "1.2.3-beta.1", "Example")
        self.assertEqual(good["packageId"], "com.example.myapp")
        for package_id in ("com.example", "com.Example.app", "../example.app", "com.example.app;echo"):
            with self.subTest(package_id=package_id), self.assertRaises(ProjectError):
                validate_metadata("My App", package_id, "1.0.0")
        with self.assertRaises(ProjectError):
            validate_metadata("My App", "com.example.app", "latest")

    def test_safely_flattens_a_single_top_level_project_directory(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive = root / "webos.zip"
            with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED) as zipped:
                zipped.writestr("my-project/index.html", "<!doctype html><title>ok</title>")
                zipped.writestr("my-project/assets/logo.svg", "<svg/>")
            output = root / "app"
            extracted, count = safe_extract(archive, output)
            self.assertEqual(extracted, output)
            self.assertEqual(count, 2)
            self.assertTrue((output / "index.html").is_file())
            self.assertTrue((output / "assets/logo.svg").is_file())

    def test_blocks_zip_path_traversal_before_writing_outside(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive = root / "evil.zip"
            with zipfile.ZipFile(archive, "w") as zipped:
                zipped.writestr("../escaped.txt", "no")
            with self.assertRaises(ProjectError):
                safe_extract(archive, root / "app")
            self.assertFalse((root.parent / "escaped.txt").exists())

    def test_blocks_symlinks_and_case_conflicting_names(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            symlink_zip = root / "link.zip"
            info = zipfile.ZipInfo("index.html")
            info.create_system = 3
            info.external_attr = (0o120777 << 16)
            with zipfile.ZipFile(symlink_zip, "w") as zipped:
                zipped.writestr(info, "target")
            with self.assertRaisesRegex(ProjectError, "Symbolic links"):
                safe_extract(symlink_zip, root / "app")

            duplicate_zip = root / "duplicate.zip"
            with zipfile.ZipFile(duplicate_zip, "w") as zipped:
                zipped.writestr("index.html", "one")
                zipped.writestr("INDEX.html", "two")
            with self.assertRaisesRegex(ProjectError, "case-conflicting"):
                safe_extract(duplicate_zip, root / "duplicate-app")

    def test_rejects_high_ratio_archives(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive = root / "bomb.zip"
            with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED) as zipped:
                zipped.writestr("index.html", "a" * (1024 * 1024))
            with self.assertRaisesRegex(ProjectError, "compression ratio"):
                safe_extract(archive, root / "app")

    def test_android_artifact_collection_recognizes_gradle_release_variant_names(self):
        outputs = Path("outputs")
        self.assertTrue(is_android_release_bundle(outputs / "bundle/universalRelease/app-release.aab", outputs))
        self.assertTrue(is_android_release_bundle(outputs / "apk/arm64-v8a/release/app-release.apk", outputs))
        self.assertFalse(is_android_release_bundle(outputs / "bundle/universalDebug/app-debug.aab", outputs))

    def test_manifest_inputs_override_project_defaults_and_runtime_is_injected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            project = root / "app"
            project.mkdir()
            (project / "index.html").write_text("<!doctype html><html><head><title>Old</title></head><body></body></html>", encoding="utf-8")
            (project / "app.json").write_text(json.dumps({"name": "From ZIP", "packageId": "com.example.fromzip", "version": "1.0.0"}), encoding="utf-8")
            args = Namespace(archive=str(root / "project.zip"), name="Chosen App", package_id="com.example.chosenapp", version="2.0.0", description="Built by test")
            metadata = read_and_write_manifest(project, args)
            runtime = root / "webos-api.js"
            runtime.write_text("window.webOS = {};", encoding="utf-8")
            inject_runtime(project, runtime)
            self.assertEqual(metadata["name"], "Chosen App")
            self.assertEqual(json.loads((project / "app.json").read_text())["packageId"], "com.example.chosenapp")
            html = (project / "index.html").read_text()
            self.assertIn('<script src="./__htmltoapp_runtime.js"></script>', html)
            self.assertTrue((project / "__htmltoapp_runtime.js").is_file())

    def test_android_signing_properties_escape_special_and_unicode_values(self):
        self.assertEqual(escape_java_property("space and ="), r"space\ and\ \=")
        self.assertEqual(escape_java_property("päss"), r"p\u00e4ss")
        self.assertEqual(escape_java_property("a\\b"), r"a\\b")
        with self.assertRaisesRegex(ValueError, "control characters"):
            escape_java_property("bad\nvalue")

    def test_optional_android_signing_is_idempotent_and_keystore_is_temporary(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            android = root / "src-tauri/gen/android"
            (android / "app").mkdir(parents=True)
            gradle = android / "app/build.gradle.kts"
            gradle.write_text('android {\n    buildTypes {\n        getByName("release") {\n            isMinifyEnabled = false\n        }\n    }\n}\n', encoding="utf-8")
            runner_temp = root / "runner-temp"
            env = {
                "ANDROID_KEYSTORE_BASE64": base64.b64encode(b"test-keystore" * 30).decode(),
                "ANDROID_STORE_PASSWORD": "store-secret",
                "ANDROID_KEY_PASSWORD": "key-secret",
                "ANDROID_KEY_ALIAS": "release",
                "RUNNER_TEMP": str(runner_temp),
            }
            old_cwd = Path.cwd()
            try:
                os.chdir(root)
                with mock.patch.dict(os.environ, env, clear=False):
                    self.assertEqual(configure_android_signing_main(), 0)
                    self.assertEqual(configure_android_signing_main(), 0)
            finally:
                os.chdir(old_cwd)
            configured = gradle.read_text(encoding="utf-8")
            self.assertEqual(configured.count("// HTMLTOAPP_RELEASE_SIGNING_CONFIG"), 1)
            self.assertEqual(configured.count('signingConfig = signingConfigs.getByName("release")'), 1)
            self.assertTrue((android / "keystore.properties").is_file())
            self.assertTrue((runner_temp / "htmltoapp-release.keystore").is_file())


if __name__ == "__main__":
    unittest.main()
