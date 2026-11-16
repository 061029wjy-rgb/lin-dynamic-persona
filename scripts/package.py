"""Package the committed front end and optional gateway. Never archive a working directory."""
from pathlib import Path
import sys, subprocess as sp, zipfile, hashlib, json, os
root=Path(__file__).resolve().parents[1]
dest=Path(os.environ.get('LDP_DIST',root/'dist')).resolve();dest.mkdir(parents=True,exist_ok=True)
git=lambda *args:sp.check_output(['git','-C',str(root),*args])
commit=git('rev-parse','HEAD').decode().strip()
files=[a.decode() for a in git('ls-tree','-r','-z','--name-only',commit).split(b'\0') if a]
def load(p):return git('show',commit+':'+p)
v=json.loads(load('manifest.json'))['version']
stage=json.loads(load('package.json')).get('linDevelopmentStage')
if stage in ('A','B'):
 import runpy
 runpy.run_path(str(root/f'scripts/package-stage-{stage.lower()}.py'),run_name='__main__')
 sys.exit(0)
if stage:
 raise SystemExit('Unknown development stage; refusing production packaging.')

build={'name':'lin-dynamic-persona','version':v,'build':'LDP-0.6.0-handoff.1','commit':commit,'baselineCommit':'0dfad16a2714a76864113e415d0cb4cd1f40494d','baselineZipSha256':'04a8bfb5aa3776edce259bb7deecdb5d4b67bcdeed8cafbd87cf1362abf6f69c','previousHandoff3Commit':'1afb9c3b7eb5c84e6a45dbe62613b7ca06a71e96','delivery':'v0.6.0 可安装构建（修复 P0-01~P0-04 并完成 T01–T15 本地与宿主矩阵）；外部实机边界见交接报告'}
meta=(json.dumps(build,ensure_ascii=False,indent=2)+'\n').encode()
def write_zip(name,entries):
 out=dest/name
 with zipfile.ZipFile(out,'w',zipfile.ZIP_DEFLATED,compresslevel=9) as z:
  for k,b in sorted(entries.items()):
   info=zipfile.ZipInfo(k,(2026,11,16,0,0,0));info.compress_type=zipfile.ZIP_DEFLATED;info.external_attr=0o644<<16;z.writestr(info,b)
 with zipfile.ZipFile(out) as z:assert z.testzip() is None
 print(name,len(entries),hashlib.sha256(out.read_bytes()).hexdigest());return out
front={p:load(p) for p in files if p in ['index.js','style.css','manifest.json','LICENSE','README.md','CHANGELOG.md'] or p.startswith('src/') or p.startswith('docs/') and not p.startswith('docs/history/')}
front['BUILD.json']=meta
write_zip('lin-dynamic-persona-'+v+'.zip',{'lin-dynamic-persona/'+p:b for p,b in front.items()})
gate={p[len('server/'):]:load(p) for p in files if p.startswith('server/lin-persona-gateway/')};gate['lin-persona-gateway/BUILD.json']=meta;gate['lin-persona-gateway/LICENSE']=load('LICENSE');write_zip('lin-persona-gateway-'+v+'.zip',gate)
(dest/'BUILD.json').write_bytes(meta)
