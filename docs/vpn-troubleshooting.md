# VPN Troubleshooting

The pipeline connects to MySQL RDS through OpenVPN by spawning the `openvpn` binary directly (see `src/steps/connect-vpn.js`). The `.ovpn` file lives at `./config/vpn/client.ovpn` (gitignored).

## Rotating credentials

```bash
# from repo root, after dropping new client.ovpn into config/vpn/
gcloud compute scp config/vpn/client.ovpn ytdt-claims:/tmp/client.ovpn --zone=us-east1-b
gcloud compute ssh ytdt-claims --zone=us-east1-b --command="
  sudo mv /tmp/client.ovpn /opt/ytdt-claims-pipeline/config/vpn/client.ovpn &&
  sudo chmod 600 /opt/ytdt-claims-pipeline/config/vpn/client.ovpn
"
```

No service restart needed — next pipeline run picks it up. Code spawns openvpn fresh each run.

**A rotated `.ovpn` loses the split-tunnel line.** The provisioner appends
`pull-filter ignore redirect-gateway`; a fresh file from the provider does not
have it. Re-add it, or the pushed `redirect-gateway def1` routes the whole VM
through the tunnel and it drops off the network. See
[Applying a new endpoint](#applying-a-new-endpoint).

## Required directives in client.ovpn

The Arclight VPN server pushes `redirect-gateway def1` (full tunnel) and uses `comp-lzo` compression. A bare `.ovpn` from the provider will need these additions to work on the GCP VM:

```
comp-lzo                                       # server pushes lzo compression
redirect-gateway def1                          # send public RDS traffic via VPN
route 10.142.0.0 255.255.240.0 net_gateway     # exclude GCP VPC from VPN
```

### Why each is needed

**`comp-lzo`** — server-side has it enabled. Without it locally, the tunnel comes up but `write to TUN/TAP : Invalid argument (code=22)` errors flood `logs/vpn.log` and packets get dropped.

**`redirect-gateway def1`** — this is the original reasoning: the RDS host is a public AWS hostname (`*.rds.amazonaws.com`) resolving to a public IP outside the pushed `10.0.0.0/16` route, so without full-tunnel MySQL traffic exits via the local gateway and bypasses the VPN entirely → connection times out.

That is no longer how the VM is set up, and it should not be. The app resolves
the endpoint to its **private** `10.0.5.x` address and connects to that, which
is already inside the pushed `10.0.0.0/16` route, so a full tunnel buys nothing
and costs the VM its network (see
[below](#the-tunnel-will-cut-the-ssh-session-that-started-it)). The provisioner
appends `pull-filter ignore redirect-gateway` and nothing else. Do not re-add
`redirect-gateway def1`.

**`route 10.142.0.0 255.255.240.0 net_gateway`** — full-tunnel hijacks everything, including MongoDB at `10.142.0.62` (GCP VPC internal). `net_gateway` keeps GCP VPC traffic on `ens4`, away from the tunnel.

## Running a script over the VPN by hand

The service runs as root, so its tunnel comes up. An SSH session does not:
`openvpn` needs root to create `tun0`, and a one-off script started as your
own user fails with

```
ERROR: Cannot ioctl TUNSETIFF tun: Operation not permitted (errno=1)
```

in `logs/vpn.log`. `connect-vpn.js` prints **"VPN connection established"**
after a five-second timer whether or not the tunnel came up, so the first
thing you see is that cheerful line, followed a minute later by
`MySQL error details: ETIMEDOUT`. The VPN never connected.

Run one-off scripts as root, with the service's own environment:

```bash
gcloud compute ssh ytdt-claims --zone=us-east1-b --command="sudo bash -c '
  set -a; source /etc/ytdt-claims-pipeline/.env; set +a
  cd /opt/ytdt-claims-pipeline && node my-script.js
'"
```

Put the script inside `/opt/ytdt-claims-pipeline` rather than `/tmp` — node
resolves `require` from the script's own directory, and from `/tmp` it finds
none of the app's modules.

For anything that only reads, say so to the server as well:

```js
await mysql.query('SET SESSION TRANSACTION READ ONLY');
```

The database is production. Leave the script behind only as long as you need
it, and delete it when you are done.

### The tunnel will cut the SSH session that started it

`redirect-gateway def1` is a full tunnel: the moment `connect-vpn.js` brings
`tun0` up, the VM's default route moves off `ens4` and your own SSH connection
dies mid-command —

```
Spawning OpenVPN client directly
Read from remote host 35.227.61.101: Connection reset by peer
client_loop: send disconnect: Broken pipe
```

Your script dies with the session, but `openvpn` does not. It is left orphaned
holding the routes, which means:

* the VM stops answering SSH, **and `--tunnel-through-iap` too** — the return
  traffic goes into the tunnel either way;
* the console shows "Failed to fetch / System offline" because the pipeline API
  is no longer reachable from outside, even though `systemctl` still reports the
  service active and the instance still reports `RUNNING`.

There is no way back in. The only fix is a hard power cycle:

```bash
gcloud compute instances reset ytdt-claims --zone=us-east1-b
```

Use `reset`, not `stop` + `start`: the external IP is not reserved, so
stop/start hands the VM a new one and the console's `NEXT_PUBLIC_API_URL`
(`https://35.227.61.101.nip.io`) stops resolving to it. After the reset,
confirm the tunnel is really gone before doing anything else:

```bash
gcloud compute ssh ytdt-claims --zone=us-east1-b --command="
  pgrep -af openvpn || echo 'no openvpn'
  sudo systemctl is-active ytdt-claims-pipeline
  ip route | head -3            # default must be via ens4, no tun0
"
curl -s https://35.227.61.101.nip.io/api/health
```

To avoid it in the first place, detach the script from the SSH session and
always tear the tunnel down yourself:

```bash
gcloud compute ssh ytdt-claims --zone=us-east1-b --command="sudo bash -c '
  set -a; source /etc/ytdt-claims-pipeline/.env; set +a
  cd /opt/ytdt-claims-pipeline
  setsid nohup node my-script.js > /tmp/my-script.log 2>&1 < /dev/null &
'"
# reconnect and read /tmp/my-script.log; the tunnel drop no longer kills it
```

```js
try {
  // ... queries
} finally {
  await mysql.end();
  process.exit(0);   // kills the openvpn child connect-vpn.js spawned
}
```

A pipeline run tears its own tunnel down when it finishes. A hand-run script
has to do the same, or it strands the VM.

## The MySQL endpoint moved

Symptom: every run fails on the VPN step with

```
getaddrinfo ENOTFOUND <something>.us-east-1.rds.amazonaws.com
```

and DataGrip on a laptop says `Unknown host ... nodename nor servname provided`.
The tunnel is fine — this is name resolution, and it fails before any
connection to MySQL is attempted.

Two things make this confusing:

* The endpoint is **split-horizon**, which is more confusing than a name that
  simply does not resolve. Public DNS *does* answer — with a CNAME to an
  `ec2-*.compute-1.amazonaws.com` name and a **public** address. Inside the VPC
  the same name gives the private `10.0.5.x` address, and that is the only one
  reachable over the tunnel. A lookup that succeeds is therefore not proof of
  anything; check *which* address came back.

  `getaddrinfo ENOTFOUND` means the endpoint is genuinely gone — that is what
  the *old* endpoint does, because its own CNAME target no longer exists.
* `client.ovpn` has no `--up` script, so openvpn **parses and discards** the
  `dhcp-option DNS 169.254.169.253` the server pushes — it only logs
  `OPTIONS IMPORT: --dhcp-option options modified`. Nothing on the VM resolves
  that name through the system resolver. The app asks the VPC resolver itself,
  in `connectVPN`, and uses whatever it answers.

### Telling "name is gone" from "we aren't asking the right resolver"

**`getent`, `getaddrinfo` and `dns.promises.resolve4()` cannot answer this
question.** All three go through the systemd-resolved stub at `127.0.0.53`,
which reads `/etc/hosts` first — so on any box where someone has pinned the
endpoint there, they hand that pin back and look exactly like a successful VPC
lookup. The test is circular. Only an explicit resolver reaches a real upstream:

With the tunnel up, query the AWS resolver directly and include a control:

```js
const r = new (require('dns').promises.Resolver)();
r.setServers(['169.254.169.253']);
await r.resolve4('amazon.com');        // control — proves the resolver answers
await r.resolve4(process.env.MYSQL_HOST);
```

If the control resolves and the endpoint gives `ENOTFOUND`, the resolver is
healthy and the endpoint genuinely no longer exists — ask whoever runs the
warehouse for the current one. If neither answers, the route to
`169.254.169.253` is missing and the tunnel is the problem.

### Applying a new endpoint

Only the hostname needs changing. The private address behind it is looked up at
every run, so there is nothing to pin and nothing to keep in step:

```bash
gcloud compute ssh ytdt-claims --zone=us-east1-b --command='set -e
NEWHOST=<new-endpoint>
sudo cp /etc/ytdt-claims-pipeline/.env /etc/ytdt-claims-pipeline/.env.bak-$(date +%Y%m%d%H%M%S)
sudo sed -i "s|^MYSQL_HOST=.*|MYSQL_HOST=$NEWHOST|" /etc/ytdt-claims-pipeline/.env
sudo systemctl restart ytdt-claims-pipeline'
```

Two things that are *not* steps any more, and should not be re-added:

* **The `/etc/hosts` pin.** It was how the app resolved the endpoint before
  `connectVPN` asked the resolver directly. A pinned address is right on the day
  it is written and silently wrong afterwards — `10.0.5.178` on 20 Oct 2026,
  `10.0.5.218` on the 22nd — and while it lasts it also misleads every other
  tool on the box, including the `mysql` CLI and anyone debugging by hostname.
* **The `route <ip> 255.255.255.255 vpn_gateway` line.** The tunnel pushes
  `10.0.0.0/16`, which covers any `10.0.5.x` the endpoint moves to.

**`pull-filter ignore redirect-gateway` must still be in `client.ovpn`, and must
be re-added after every credential rotation.** The provisioner appends it; a
fresh `.ovpn` dropped in by hand does not have it, and without it the pushed
`redirect-gateway def1` takes the entire VM off the network for as long as the
tunnel is up.

If the resolver cannot answer, the run now fails at `connectVPN` with the
resolver's address in the message rather than timing out later against an
unreachable host. `MYSQL_IP` is still read if it is set, as a deliberate
break-glass override; provisioning never writes it, and it should be unset again
once the resolver works.

## Diagnostic commands

Live tunnel + routes:
```bash
gcloud compute ssh ytdt-claims --zone=us-east1-b --command="
  sudo tail -40 /opt/ytdt-claims-pipeline/logs/vpn.log
  echo '---ROUTES---'
  ip route
"
```

What to look for in `vpn.log`:
- `Initialization Sequence Completed` — tunnel is up
- `write to TUN/TAP : Invalid argument` — missing `comp-lzo`
- `WARNING: 'comp-lzo' is present in remote config but missing in local` — same
- `Options error: option 'route' cannot be used in this context` — caused by `route-nopull`; remove it

What to look for in `ip route` (when VPN is up):
- `default via 10.142.0.1 dev ens4` — should stay (Mongo path)
- `10.0.0.0/16 via 192.168.2.5 dev tun0` — RDS via VPN ✓
- `10.142.0.0/20 via 10.142.0.1` — VPC excluded from VPN ✓
- `0.0.0.0/1 via 192.168.2.5 dev tun0` — public traffic via VPN ✓

## Pipeline service

```bash
sudo systemctl status ytdt-claims-pipeline
sudo journalctl -u ytdt-claims-pipeline -f
```

Ignore `openvpn-client@client.service` and `openvpn.service` — the pipeline doesn't use them.