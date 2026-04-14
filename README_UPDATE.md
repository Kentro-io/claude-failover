## Quick Update (one command)

```bash
cd /tmp && git clone https://github.com/Kentro-io/claude-failover.git cf-update && cd cf-update && sudo npm install -g . && claude-failover stop && claude-failover start -d && rm -rf /tmp/cf-update
```

Or step by step:
```bash
git clone https://github.com/Kentro-io/claude-failover.git /tmp/cf-update
cd /tmp/cf-update
sudo npm install -g .
claude-failover stop
claude-failover start -d
rm -rf /tmp/cf-update
```
