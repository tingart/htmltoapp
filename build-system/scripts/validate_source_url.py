#!/usr/bin/env python3
"""Accept only public HTTPS archive URLs for maintainer-triggered builds."""
import ipaddress
import sys
from urllib.parse import urlsplit


def main() -> int:
    if len(sys.argv) != 2:
        print("Provide one archive URL.", file=sys.stderr)
        return 2
    value = sys.argv[1].strip()
    try:
        parsed = urlsplit(value)
        host = parsed.hostname
        if parsed.scheme != "https" or not host or parsed.username or parsed.password or parsed.fragment:
            raise ValueError("Use an HTTPS URL without embedded credentials or a fragment.")
        if host.lower() in {"localhost", "localhost.localdomain"} or host.lower().endswith(".local"):
            raise ValueError("Local network hosts are not allowed.")
        try:
            address = ipaddress.ip_address(host)
            if not address.is_global:
                raise ValueError("Private, loopback and reserved IP addresses are not allowed.")
        except ValueError as error:
            if "does not appear to be an IPv4 or IPv6 address" not in str(error):
                raise
        if len(value) > 4096:
            raise ValueError("URL is too long.")
    except ValueError as error:
        print(f"Invalid archive URL: {error}", file=sys.stderr)
        return 2
    print(value)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
