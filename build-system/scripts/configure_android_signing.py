#!/usr/bin/env python3
"""Configure optional Android release signing from GitHub Actions secrets."""
from __future__ import annotations

import base64
import os
import re
import sys
from pathlib import Path


def escape_java_property(value: str) -> str:
    """Escape a value for Java Properties.load(InputStream), which reads ISO-8859-1."""
    slash = chr(92)
    escaped = []
    for character in value:
        codepoint = ord(character)
        if character == slash:
            escaped.append(slash * 2)
        elif character == " ":
            escaped.append(slash + " ")
        elif codepoint == 9:
            escaped.append(slash + "t")
        elif codepoint == 12:
            escaped.append(slash + "f")
        elif character in "=:#!":
            escaped.append(slash + character)
        elif codepoint < 0x20 or codepoint == 0x7F:
            raise ValueError("Android signing values may not contain control characters.")
        elif codepoint > 0x7E:
            utf16 = character.encode("utf-16-be")
            escaped.extend(f"{slash}u{int.from_bytes(utf16[offset:offset + 2], 'big'):04x}" for offset in range(0, len(utf16), 2))
        else:
            escaped.append(character)
    return "".join(escaped)


def main() -> int:
    encoded = os.environ.get("ANDROID_KEYSTORE_BASE64", "").strip()
    store_password = os.environ.get("ANDROID_STORE_PASSWORD", "")
    key_password = os.environ.get("ANDROID_KEY_PASSWORD", "")
    alias = os.environ.get("ANDROID_KEY_ALIAS", "")
    if not any((encoded, store_password, key_password, alias)):
        print("Android signing secrets are not configured; APK/AAB output will be unsigned.")
        return 0
    if not all((encoded, store_password, key_password, alias)):
        print("Android signing requires ANDROID_KEYSTORE_BASE64, ANDROID_STORE_PASSWORD, ANDROID_KEY_PASSWORD and ANDROID_KEY_ALIAS.", file=sys.stderr)
        return 2
    if any("\n" in value or "\r" in value for value in (store_password, key_password, alias)):
        print("Android signing values may not contain newlines.", file=sys.stderr)
        return 2

    try:
        keystore_bytes = base64.b64decode(encoded, validate=True)
        if len(keystore_bytes) < 100:
            raise ValueError("decoded keystore is too small")
        temp_dir = Path(os.environ.get("RUNNER_TEMP", "/tmp")).resolve()
        temp_dir.mkdir(parents=True, exist_ok=True)
        keystore_path = temp_dir / "htmltoapp-release.keystore"
        keystore_path.write_bytes(keystore_bytes)
        keystore_path.chmod(0o600)

        android_root = Path("src-tauri/gen/android")
        gradle_file = android_root / "app/build.gradle.kts"
        if not gradle_file.is_file():
            raise FileNotFoundError(f"Tauri Android Gradle file is missing: {gradle_file}")
        gradle = gradle_file.read_text(encoding="utf-8")
        if "// HTMLTOAPP_RELEASE_SIGNING_CONFIG" not in gradle:
            imports = "import java.io.FileInputStream\nimport java.util.Properties\n"
            gradle = imports + gradle
            match = re.search(r"(?m)^(\s*)buildTypes\s*\{", gradle)
            if not match:
                raise ValueError("Could not find the Android buildTypes block to configure release signing.")
            indent = match.group(1)
            config = '''{indent}signingConfigs {
{indent}    create("release") {
{indent}        val keystorePropertiesFile = rootProject.file("keystore.properties")
{indent}        val keystoreProperties = Properties()
{indent}        keystoreProperties.load(FileInputStream(keystorePropertiesFile))
{indent}        keyAlias = keystoreProperties["keyAlias"] as String
{indent}        keyPassword = keystoreProperties["keyPassword"] as String
{indent}        storeFile = file(keystoreProperties["storeFile"] as String)
{indent}        storePassword = keystoreProperties["storePassword"] as String
{indent}    }
{indent}}
{indent}// HTMLTOAPP_RELEASE_SIGNING_CONFIG

'''.replace("{indent}", indent)
            gradle = gradle[: match.start()] + config + gradle[match.start() :]

        release = re.search(r'(?m)^(\s*)getByName\("release"\)\s*\{', gradle)
        if not release:
            raise ValueError('Could not find getByName("release") in the Android build types.')
        block_start = release.end()
        following = gradle[block_start : block_start + 300]
        if "signingConfig = signingConfigs.getByName(\"release\")" not in following:
            indent = release.group(1) + "    "
            gradle = gradle[:block_start] + f'\n{indent}signingConfig = signingConfigs.getByName("release")' + gradle[block_start:]

        gradle_file.write_text(gradle, encoding="utf-8")
        properties = android_root / "keystore.properties"
        properties.write_text(
            "\n".join(
                [
                    f"keyAlias={escape_java_property(alias)}",
                    f"keyPassword={escape_java_property(key_password)}",
                    f"storePassword={escape_java_property(store_password)}",
                    f"storeFile={escape_java_property(keystore_path.as_posix())}",
                    "",
                ]
            ),
            encoding="utf-8",
        )
        properties.chmod(0o600)
        print("Android release signing is configured from repository secrets.")
        return 0
    except (OSError, ValueError) as error:
        print(f"Android signing setup failed: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
