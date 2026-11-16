"""Produce the full, isolated Stage A handoff from Git HEAD. Never publish a production/gateway ZIP."""
from pathlib import Path
from tempfile import TemporaryDirectory
import hashlib
import json
import os
import subprocess
import zipfile

ROOT = Path(__file__).resolve().parents[1]
BASE = '47052916585dcd3a7d55980dc5171380c6343f30'
BASE_ZIP_SHA = '737a1b286a621870ce75eddeaf26ceb22e3665df7a0f69fb9d8aaaa226a5ec0a'
BASE_HANDOFF_SHA = 'c00682318faeae2e06f92dbc92e65b6cf66363770a514dcf00099a4f82ddb6c1'
VERSION, BUILD = '0.7.0', 'LDP-0.7.0-stage-A.1'
ZIPNAME = 'lin-dynamic-persona-0.7.0-stage-A.zip'
DIR = 'lin-dynamic-persona/'
def sha(b): return hashlib.sha256(b).hexdigest()
def git(*args): return subprocess.check_output(['git','-C',str(ROOT),*args])
def load(commit,p): return git('show',commit+':'+p)

def main():
    dest = Path(os.environ.get('LDP_DIST', ROOT/'dist')).resolve()
    dest.mkdir(parents=True,exist_ok=True)
    commit = git('rev-parse','HEAD').decode().strip()
    subprocess.run(['git','-C',str(ROOT),'merge-base','--is-ancestor',BASE,commit],check=True)
    if git('status','--porcelain','--untracked-files=no'):
        raise SystemExit('Commit tracked changes before packaging.')
    names=[n.decode() for n in git('ls-tree','-r','-z','--name-only',commit).split(b'\0') if n]
    files={n:load(commit,n) for n in names}
    if json.loads(files['manifest.json'])['version']!=VERSION or json.loads(files['package.json'])['version']!=VERSION:
        raise SystemExit('Stage A version mismatch.')
    # The Stage A scope forbids modifications to prompt, scheduler, providers, gateway and other runtime modules.
    changed=[n.decode() for n in git('diff','--name-only','-z',BASE,commit).split(b'\0') if n]
    if any((n.startswith('server/') or n.startswith('src/') and n not in ('src/storage.js','src/queue-ledger.js') or n in ('index.js','style.css','tests/services.test.js')) for n in changed):
        raise SystemExit('Unexpected change outside Stage A runtime boundary.')
    path=Path(os.environ.get('LDP_BASE_ZIP',ROOT/'handoff/lin-dynamic-persona-0.6.0.zip'))
    original=path.read_bytes()
    if sha(original)!=BASE_ZIP_SHA: raise SystemExit('Wrong 0.6.0 installation ZIP.')
    with TemporaryDirectory() as dd:
        bundle=Path(dd)/'stage-A.bundle'
        git('bundle','create',str(bundle),'HEAD')
        git('bundle','verify',str(bundle))
        hist=bundle.read_bytes()
    build={
        'name':'lin-dynamic-persona','version':VERSION,'build':BUILD,'commit':commit,'baselineCommit':BASE,
        'baselineZipSha256':BASE_ZIP_SHA,'baselineHandoffSha256':BASE_HANDOFF_SHA,'gitBundleSha256':sha(hist),
        'physicalDbVersion':6,'personaBackupVersion':5,'stage':'A','productionReady':False,
        'delivery':'阶段 B 的唯一代码输入；不能单独投产。数据库验收与剩余集成失败见 docs/QUEUE-TEST-REPORT.md。'}
    files['BUILD.json']=(json.dumps(build,ensure_ascii=False,indent=2)+'\n').encode()
    files['handoff/stage-A.bundle']=hist
    files['handoff/lin-dynamic-persona-0.6.0.zip']=original
    info='\n## 本次打包身份\n\n源码提交：' + commit + '\n\n完整源码交付（handoff/stage-A.bundle）SHA-256：' + sha(hist) + '\n'
    files['HANDOFF-TO-B.md']+=info.encode()
    files['SHA256SUMS.txt']=''.join(sha(data)+'  '+path+'\n' for path,data in sorted(files.items())).encode()
    final=dest/ZIPNAME
    with zipfile.ZipFile(final,'w',zipfile.ZIP_DEFLATED,compresslevel=9) as z:
        for path,data in sorted(files.items()):
            zi=zipfile.ZipInfo(DIR+path,(2026,11,17,0,0,0));zi.compress_type=zipfile.ZIP_DEFLATED;zi.external_attr=0o644<<16
            z.writestr(zi,data)
    # Check the actual ZIP, not the staging dictionary. Reject missing, duplicate and extra files.
    with zipfile.ZipFile(final) as z:
        assert z.testzip() is None and len(z.namelist())==len(set(z.namelist()))==len(files)
        listing=z.read(DIR+'SHA256SUMS.txt').decode().splitlines()
        expected={}
        for line in listing:
            d,p=line.split('  ',1);expected[DIR+p]=d
        assert set(expected)==set(z.namelist())-{DIR+'SHA256SUMS.txt'}
        assert all(sha(z.read(k))==v for k,v in expected.items())
    result=sha(final.read_bytes())
    report=files['HANDOFF-TO-B.md'].decode()+'\n整个交付 ZIP（'+ZIPNAME+'）SHA-256：'+result+'\n'
    (dest/'HANDOFF-TO-B-0.7.0.md').write_text(report,encoding='utf-8')
    (dest/(ZIPNAME+'.sha256')).write_text(result+'  '+ZIPNAME+'\n',encoding='ascii')
    (dest/'BUILD.json').write_bytes(files['BUILD.json'])
    print(f'{BUILD}  {commit}\n{ZIPNAME}: {len(files)} files; SHA-256 {result}')

if __name__=='__main__': main()
