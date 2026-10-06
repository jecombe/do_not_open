# Writes the Grafana dashboards in dashboards/ (committed, provisioned read-only). Edit here,
# then: python3 deploy/monitoring/grafana/dashboards.py deploy/monitoring/grafana/dashboards
import json, sys
DS={"type":"prometheus","uid":"prometheus"}
def mk(title, uid, panels_spec, variables, desc):
    panels=[]; y=0; pid=1
    for row in panels_spec:
        if isinstance(row,str):
            panels.append({"type":"row","title":row,"id":pid,"gridPos":{"h":1,"w":24,"x":0,"y":y},"collapsed":False,"panels":[]}); pid+=1; y+=1; continue
        x=0
        h=max(p.get("h",8) for p in row)
        for p in row:
            w=p.get("w",24//len(row))
            panel={"id":pid,"title":p["title"],"type":p.get("type","timeseries"),"datasource":DS,
                   "gridPos":{"h":p.get("h",8),"w":w,"x":x,"y":y},
                   "targets":[{"refId":chr(65+i),"datasource":DS,"expr":e[0],"legendFormat":e[1] if len(e)>1 else "","instant":p.get("type")=="stat" or p.get("type")=="table"} for i,e in enumerate(p["exprs"])],
                   "fieldConfig":{"defaults":{"unit":p.get("unit","short"),**({"decimals":p["decimals"]} if "decimals" in p else {}),
                        **({"thresholds":{"mode":"absolute","steps":p["thresholds"]}} if "thresholds" in p else {"thresholds":{"mode":"absolute","steps":[{"color":"text","value":None}]}} if p.get("type")=="stat" else {}),
                        **({"color":{"mode":"thresholds"}} if p.get("type")=="stat" else {}),
                        "custom": ({"drawStyle":"line","lineWidth":2,"fillOpacity":10,"showPoints":"never"} if p.get("type","timeseries")=="timeseries" else {})},"overrides":[]},
                   "options":({"reduceOptions":{"calcs":["lastNotNull"],"fields":"","values":False},"colorMode":"value","graphMode":"area","textMode":"auto"} if p.get("type")=="stat"
                              else {"legend":{"displayMode":"list","placement":"bottom","showLegend":True},"tooltip":{"mode":"multi","sort":"desc"}})}
            if "desc" in p: panel["description"]=p["desc"]
            if "mappings" in p: panel["fieldConfig"]["defaults"]["mappings"]=p["mappings"]
            panels.append(panel); pid+=1; x+=w
        y+=h
    return {"uid":uid,"title":title,"description":desc,"tags":["dno"],"timezone":"utc","schemaVersion":41,"version":1,"editable":False,
            "refresh":"30s","time":{"from":"now-24h","to":"now"},"panels":panels,
            "templating":{"list":variables},"annotations":{"list":[]}}

net={"name":"network","label":"Network","type":"query","datasource":DS,"query":{"query":"label_values(dno_info, network)","refId":"N"},
     "definition":"label_values(dno_info, network)","refresh":2,"current":{},"includeAll":False,"multi":False,"sort":1}
N='network="$network"'
G=[{"color":"green","value":None}]
protocol=mk("DO NOT OPEN · Protocol","dno-protocol",[
 "The collection",
 [{"title":"Boxes minted","type":"stat","exprs":[[f"dno_boxes_minted{{{N}}}"]],"w":4,"h":4},
  {"title":"Cats revealed","type":"stat","exprs":[[f"dno_boxes_opened{{{N}}}"]],"w":4,"h":4},
  {"title":"Duels open","type":"stat","exprs":[[f"dno_duels_open{{{N}}}"]],"w":4,"h":4},
  {"title":"Requests waiting for a proof","type":"stat","exprs":[[f"sum(dno_requests_pending{{{N}}}) or vector(0)"]],"w":4,"h":4,"thresholds":G+[{"color":"orange","value":5},{"color":"red","value":20}]},
  {"title":"Players seen","type":"stat","exprs":[[f"dno_users{{{N}}}"]],"w":4,"h":4},
  {"title":"Milestones reached","type":"stat","exprs":[[f"dno_milestones_reached{{{N}}}"]],"w":4,"h":4}],
 [{"title":"Minted and opened","exprs":[[f"dno_boxes_minted{{{N}}}","minted"],[f"dno_boxes_opened{{{N}}}","opened"]]},
  {"title":"Duels","exprs":[[f"dno_duels{{{N}}}","ever posted"],[f"dno_duels_open{{{N}}}","open"]]}],
 [{"title":"Requests waiting for their KMS proof, by kind","exprs":[[f"dno_requests_pending{{{N}}}","{{kind}}"],[f"sum(dno_requests_pending{{{N}}}) or vector(0)","total"]],"desc":"Openings, alive checks, entanglements, duels and milestones whose decryption proof was not submitted yet."},
  {"title":"Oldest pending request (blocks)","exprs":[[f"dno_request_oldest_pending_blocks{{{N}}}","blocks"]],"desc":"Above 150 blocks (half an hour) the ProofStuck alert fires."}],
 [{"title":"Protocol events indexed (per hour)","exprs":[[f"delta(dno_events{{{N}}}[1h])","events"]]},
  {"title":"Players seen and signed in","exprs":[[f"dno_users{{{N}}}","seen"],[f"dno_users_registered{{{N}}}","signed in"]]}],
 "The indexer",
 [{"title":"Lag (blocks)","type":"stat","exprs":[[f"dno_indexer_lag_blocks{{{N}}}"]],"w":6,"h":4,"thresholds":G+[{"color":"orange","value":10},{"color":"red","value":50}]},
  {"title":"Last pass","type":"stat","exprs":[[f"time() - dno_indexer_last_pass_timestamp_seconds{{{N}}}"]],"unit":"s","w":6,"h":4,"thresholds":G+[{"color":"orange","value":120},{"color":"red","value":300}]},
  {"title":"Failed passes in a row","type":"stat","exprs":[[f"dno_indexer_consecutive_failures{{{N}}}"]],"w":6,"h":4,"thresholds":G+[{"color":"red","value":5}]},
  {"title":"Indexed block","type":"stat","exprs":[[f"dno_indexer_block{{{N}}}"]],"w":6,"h":4,"decimals":0,"unit":"none"}],
 [{"title":"Indexed, finalized and target blocks","exprs":[[f"dno_chain_target_block{{{N}}}","target"],[f"dno_indexer_block{{{N}}}","indexed"],[f"dno_indexer_finalized_block{{{N}}}","finalized"]],"decimals":0,"unit":"none"},
  {"title":"Periodic tasks failing","exprs":[[f"dno_task_failing{{{N}}}","{{task}}"]],"desc":"1 while a task's last run threw: finality sweep, reconciliation, Arweave images, herald."}],
 [{"title":"RPC latency by endpoint","exprs":[[f"dno_rpc_latency_seconds{{{N}}}","{{endpoint}}"]],"unit":"s"},
  {"title":"RPC calls failed per minute, by endpoint","exprs":[[f'rate(dno_rpc_requests_total{{{N},result="failed"}}[5m]) * 60',"{{endpoint}}"]]}],
 "Traffic and services",
 [{"title":"Requests per second, by route","exprs":[[f'sum by (route) (rate(dno_http_request_duration_seconds_count{{{N},route!="/metrics"}}[5m]))',"{{route}}"]],"unit":"reqps"},
  {"title":"Errors per second, by status","exprs":[[f'sum by (status) (rate(dno_http_request_duration_seconds_count{{{N},status=~"4..|5.."}}[5m]))',"{{status}}"]],"unit":"reqps"}],
 [{"title":"Latency p95, by route","exprs":[[f'histogram_quantile(0.95, sum by (route, le) (rate(dno_http_request_duration_seconds_bucket{{{N},route!="/metrics"}}[5m])))',"{{route}}"]],"unit":"s"},
  {"title":"Zama relayer proxy calls, by operation and status","exprs":[[f'sum by (route, status) (rate(dno_http_request_duration_seconds_count{{{N},route=~"/relayer/.*"}}[5m])) * 60',"{{route}} {{status}}"]],"desc":"Per minute. On mainnet each decryption and input is billed to the collection."}],
 [{"title":"Token images on Arweave","exprs":[[f"dno_images_archived{{{N}}}","stored"]],"w":8},
  {"title":"Gemini questions today","exprs":[[f"dno_chat_model_questions_today{{{N}}}","asked"],[f"dno_chat_model_questions_limit{{{N}}}","limit"]],"w":8},
  {"title":"Herald posts by account and status","exprs":[[f"dno_herald_posts{{{N}}}","{{network_account}} {{status}}"]],"w":8}],
 "The mainnet whitelist",
 [{"title":"Seats taken","type":"stat","exprs":[[f"dno_whitelist_seats_taken{{{N}}}"]],"w":4,"h":4,"desc":"X accounts with every boarding task done, and wallets that claimed and played the testnet; an X account and its linked wallet count once."},
  {"title":"Seats filled","type":"stat","exprs":[[f"dno_whitelist_seats_taken{{{N}}} / dno_whitelist_seats_places{{{N}}}"]],"unit":"percentunit","w":4,"h":4,"thresholds":G+[{"color":"orange","value":0.9},{"color":"red","value":1}],"desc":"Out of ALLOW_LIST_PLACES. Full: nobody new gets a seat."},
  {"title":"X accounts connected","type":"stat","exprs":[[f'dno_xpass_passes{{{N},stage="connected"}}']],"w":4,"h":4},
  {"title":"Wallet claims","type":"stat","exprs":[[f"dno_whitelist_claims{{{N}}}"]],"w":4,"h":4,"desc":"Wallets that signed a claim; they sit down once they minted, opened or dueled."},
  {"title":"Sign in with X","type":"stat","exprs":[[f"dno_xpass_signin_enabled{{{N}}}"]],"w":4,"h":4,"mappings":[{"type":"value","options":{"0":{"text":"OFF"},"1":{"text":"ON"}}}],"thresholds":[{"color":"orange","value":None},{"color":"green","value":1}],"desc":"ON: X_CLIENT_ID is set. OFF: players prove their account with a post carrying their code."},
  {"title":"Ideas in the box","type":"stat","exprs":[[f"dno_ideas_received{{{N}}}"]],"w":4,"h":4,"desc":"Read them with GET /v1/ideas?token=ALLOW_LIST_ADMIN_TOKEN."}],
 [{"title":"Seats taken against the places","exprs":[[f"dno_whitelist_seats_taken{{{N}}}","taken"],[f"dno_whitelist_seats_places{{{N}}}","places"]]},
  {"title":"Boarding funnel","exprs":[[f"dno_xpass_passes{{{N}}}","{{stage}}"]],"desc":"started: a pass handed out; connected: an X account proved; seated: every required task done; wallet: a wallet linked."}],
 [{"title":"Tasks on X declared, by task","exprs":[[f"dno_xpass_tasks{{{N}}}","{{task}}"]],"desc":"Declared by the players, checked by hand before mainnet."},
  {"title":"Sign in with X per hour, by outcome","exprs":[[f"sum by (outcome) (increase(dno_xpass_sign_ins_total{{{N}}}[1h]))","{{outcome}}"]],"desc":"x-down: X refused the code or did not answer; sign-in-refused: the player cancelled on X; list-full: no seat left."}],
 "The studio",
 [{"title":"Open","type":"stat","exprs":[[f"dno_studio_open{{{N}}}"]],"w":4,"h":4,"mappings":[{"type":"value","options":{"0":{"text":"OFF"},"1":{"text":"OPEN"}}}],"thresholds":[{"color":"red","value":None},{"color":"green","value":1}],"desc":"Open: the fal key and the StudioPacks contract are there, and STUDIO_PAUSED is not set."},
  {"title":"Packs sold","type":"stat","exprs":[[f"dno_studio_packs_sold{{{N}}}"]],"w":4,"h":4},
  {"title":"USDC brought in","type":"stat","exprs":[[f"dno_studio_revenue_usdc{{{N}}}"]],"unit":"currencyUSD","w":4,"h":4,"desc":"Paid for packs, straight to the treasury. Test USDC on Sepolia."},
  {"title":"AI cost, all time","type":"stat","exprs":[[f"dno_studio_spent_total_usd{{{N}}}"]],"unit":"currencyUSD","w":4,"h":4,"desc":"Estimated from studio.json's estimatedCostUsd, failed jobs included: check it against fal's bill."},
  {"title":"Margin","type":"stat","exprs":[[f"dno_studio_revenue_usdc{{{N}}} - dno_studio_spent_total_usd{{{N}}}"]],"unit":"currencyUSD","w":4,"h":4,"thresholds":[{"color":"red","value":None},{"color":"green","value":0}],"desc":"USDC brought in minus the estimated AI cost. The StudioLosingMoney alert fires when it stays negative."},
  {"title":"Today's AI budget used","type":"stat","exprs":[[f"dno_studio_spent_today_usd{{{N}}} / dno_studio_daily_budget_usd{{{N}}}"]],"unit":"percentunit","w":4,"h":4,"thresholds":G+[{"color":"orange","value":0.8},{"color":"red","value":0.98}],"desc":"Past it, generation waits for midnight UTC (STUDIO_DAILY_BUDGET_USD)."}],
 [{"title":"Generations by kind and status","exprs":[[f"dno_studio_jobs{{{N}}}","{{kind}} {{status}}"]],"desc":"failed: unit given back; rejected: refused by the safety checker or past the day's refunds, unit kept."},
  {"title":"AI spend today against the budget","exprs":[[f"dno_studio_spent_today_usd{{{N}}}","spent today"],[f"dno_studio_daily_budget_usd{{{N}}}","daily budget"]],"unit":"currencyUSD"}],
],[net],"The protocol on one network: collection, pending proofs, indexer, RPC pool, API traffic, side services, the mainnet whitelist, the studio. Public facts and counts only.")

srv=mk("DO NOT OPEN · Server and URLs","dno-server",[
 "Public URLs",
 [{"title":"Up","type":"stat","exprs":[["probe_success","{{instance}}"]],"w":12,"h":5,"mappings":[{"type":"value","options":{"0":{"text":"DOWN"},"1":{"text":"UP"}}}],"thresholds":[{"color":"red","value":None},{"color":"green","value":1}]},
  {"title":"Certificate expires in","type":"stat","exprs":[["probe_ssl_earliest_cert_expiry - time()","{{instance}}"]],"unit":"s","w":12,"h":5,"thresholds":[{"color":"red","value":None},{"color":"orange","value":14*86400},{"color":"green","value":30*86400}]}],
 [{"title":"Response time","exprs":[["probe_duration_seconds","{{instance}}"]],"unit":"s","w":24}],
 "The machine",
 [{"title":"CPU used","exprs":[['1 - avg(rate(node_cpu_seconds_total{mode="idle"}[5m]))',"cpu"]],"unit":"percentunit"},
  {"title":"Memory available","exprs":[["node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes","available"]],"unit":"percentunit"},
  {"title":"Disk used","exprs":[['1 - node_filesystem_avail_bytes{mountpoint="/"} / node_filesystem_size_bytes{mountpoint="/"}',"/"]],"unit":"percentunit"}],
 [{"title":"Network in and out","exprs":[['sum(rate(node_network_receive_bytes_total{device!~"lo|veth.*|br-.*|docker.*"}[5m]))',"in"],['sum(rate(node_network_transmit_bytes_total{device!~"lo|veth.*|br-.*|docker.*"}[5m]))',"out"]],"unit":"Bps"},
  {"title":"Load","exprs":[["node_load1","1 min"],["node_load5","5 min"]]}],
 "Containers (every project on the server)",
 [{"title":"CPU by container","exprs":[['sum by (name) (rate(container_cpu_usage_seconds_total{name!=""}[5m]))',"{{name}}"]],"unit":"percentunit"},
  {"title":"Memory by container","exprs":[['container_memory_working_set_bytes{name!=""}',"{{name}}"]],"unit":"bytes"}],
],[],"The server shared by testnet and mainnet: public URLs, machine, containers.")
for d,f in [(protocol,"protocol.json"),(srv,"server.json")]:
    json.dump(d,open(sys.argv[1]+"/"+f,"w"),indent=2)
