[![CI Test Status][ci-img]][ci-url]
[![Code Climate][clim-img]][clim-url]

# haraka-plugin-helo.checks

This plugin performs a number of checks on the HELO string.

HELO strings are very often forged or dubious in spam and so this can be a
highly effective and false-positive free anti-spam measure.

## Usage

helo.checks results can be accessed by subsequent plugins:

```js
const h = connection.results.get('helo.checks');
if (h.pass && h.pass.length > 5) {
    // nice job, you passed 6+ tests
}
if (h.fail && h.fail.length > 3) {
    // yikes, you failed 4+ tests!
}
if (connection.results.has('helo.checks','pass', /^forward_dns/) {
    // the HELO hostname is valid
}
```

## Configuration

- helo.checks.regexps

  List of regular expressions to match against the HELO string. The regular
  expressions are automatically wrapped in `^` and `$` so they always match
  the entire string.

- helo.checks.ini

```sh
cp node_modules/haraka-plugin-helo.checks/config/helo.checks.ini config/helo.checks.ini
$EDITOR config/helo.checks.ini
```

INI file which controls enabling of certain checks:

- dns_timeout=30

How many seconds to wait for DNS queries to timeout.

### [check]

- valid_hostname=true

  Checks that the HELO has at least one '.' in it and the organizational
  name is possible (ie, a host within a Public Suffix).

- bare_ip=true

  Checks for HELO <IP> where the IP is not surrounded by square brackets.
  This is an RFC violation so should always be enabled.

- dynamic=true

  Checks to see if all or part the connecting IP address appears within
  the HELO argument to indicate that the client has a dynamic IP address.

- literal_mismatch=1|2|3

  Checks to see if the IP literal used matches the connecting IP address.
  If set to 1, the full IP must match. If set to 2, the /24 must match.
  If set to 3, the /24 may match, or the IP can be private (RFC 1918).

- match_re=true

  See above. This is merely an on/off toggle.

- big_company=true

  See below. This is merely an on/off toggle.

- forward_dns=true

  Perform a DNS lookup of the HELO hostname and validate that the IP of
  the remote is included in the IP(s) of the HELO hostname.

  This test requires that the valid_hostname check is also enabled.

- rdns_match=true

  Sees if the HELO hostname (or at least the domain) match the rDNS
  hostname(s).

- host_mismatch=true

  If HELO is called multiple times, checks if the hostname differs between
  EHLO invocations.

- proto_mismatch=true

  If EHLO was sent and the host later tries to then send HELO or vice-versa.

### [reject]

For all of the checks included above, a matching key in the reject section
controls whether messages that fail the test are rejected.

Defaults shown:

```ini
[reject]
host_mismatch=false
literal_mismatch=false
proto_mismatch=false
rdns_match=false
dynamic=false
bare_ip=false
valid_hostname=false
forward_dns=false
big_company=false
```

### [skip]

- private_ip=true

  Bypasses checks for clients within RFC1918, Loopback or APIPA IP address ranges.

- relaying

  Bypass checks for clients who have relaying privileges (whitelisted IP,
  SMTP-AUTH, etc).

### [bigco]

A list of <helo>=<rdns>[,<rdns>...] to match against. If the HELO matches
what's on the left hand side, the reverse-DNS must match one of the
entries on the right hand side or the mail is blocked.

Example:

```ini
yahoo.com=yahoo.com,yahoo.co.jp
aol.com=aol.com
gmail.com=google.com
```

<!-- leave these buried at the bottom of the document -->

[ci-img]: https://github.com/haraka/haraka-plugin-helo.checks/actions/workflows/ci.yml/badge.svg
[ci-url]: https://github.com/haraka/haraka-plugin-helo.checks/actions/workflows/ci.yml
[clim-img]: https://codeclimate.com/github/haraka/haraka-plugin-helo.checks/badges/gpa.svg
[clim-url]: https://codeclimate.com/github/haraka/haraka-plugin-helo.checks
