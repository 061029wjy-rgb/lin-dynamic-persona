"""Package the committed Stage B handoff; this never produces a production release."""
from pathlib import Path
from tempfile import TemporaryDirectory
import hashlib
import json
import os
import subprocess
import zipfile

ROOT=Path(__file__).resolve().parents[1]
BASE='c55bd0bcddaccbf9ede39d29d4118dd2e5231849'
BASE_ZIP_SHA='896e41088967ef30e14c391f8e65afbd3bb0c07937fc3b96ab92773682888838'
BASE_BUNDLE_SHA='27aa5986731afbe3f83fc8ae72d3869e8f9b268999d7ced8e65c03e79784cbfd'
VERSION,BUILD='0.7.0','LDP-0.7.0-stage-B.1'
NAME='lin-dynamic-persona-0.7.0-stage-B.zip'
PREFIX='lin-dynamic-persona/'
def sha(data): return hashlib.sha256(data).hexdigest()
def git(*args): return subprocess.check_output(['git','-C',str(ROOT),*args])

def main():
    dest=Path(os.environ.get('LDP_DIST',ROOT/'dist')).resolve()
    dest.mkdir(parents=True,exist_ok=True)
    head=git('rev-parse','HEAD').decode().strip()
    subprocess.run(['git','-C',str(ROOT),'merge-base','--is-ancestor',BASE,head],check=True)
    if git('status','--porcelain','--untracked-files=no'):
        raise SystemExit('Commit tracked changes before packaging.')
    names=[n.decode() for n in git('ls-tree','-r','-z','--name-only',head).split(b'\0') if n]
    files={n:git('show',head+':'+n) for n in names}
    package=json.loads(files['package.json'])
    if package.get('linDevelopmentStage')!='B' or package['version']!=VERSION or json.loads(files['manifest.json'])['version']!=VERSION:
        raise SystemExit('Stage B version or development marker mismatch.')
    allowed={'src/controller.js','src/service.js','src/ui.js','src/queue-ledger.js','src/queue-runtime.js'}
    changed=[n.decode() for n in git('diff','--name-only','-z',BASE,head).split(b'\0') if n]
    if any(n.startswith('server/') or n.startswith('src/') and n not in allowed or n in ('index.js','style.css','tests/queue-storage.test.js','tests/queue-cases.mjs','tests/queue-driver.js') for n in changed):
        raise SystemExit('Unexpected change outside the reviewed Stage B integration boundary.')
    report=json.loads(files['docs/evidence/phase-b/results.json'])
    if report['tests']!={'total':108,'passed':108,'failed':0,'skipped':0} or report['productionReady']:
        raise SystemExit('Missing successful local verification or invalid production claim.')
    with TemporaryDirectory() as directory:
        bundle=Path(directory)/'stage-B.bundle'
        git('bundle','create',str(bundle),'HEAD')
        git('bundle','verify',str(bundle))
        history=bundle.read_bytes()
    build={'name':'lin-dynamic-persona','version':VERSION,'build':BUILD,'commit':head,'stage':'B','productionReady':False,
        'baselineCommit':BASE,'inputStageAZipSha256':BASE_ZIP_SHA,'inputStageABundleSha256':BASE_BUNDLE_SHA,
        'gitBundleSha256':sha(history),'physicalDbVersion':6,'personaBackupVersion':5,'localTests':report['tests'],
        'nativeBrowserRetest':'blocked: Chromium socket EPERM','liveHostAcceptance':'not run','paidProviderCalls':0,
        'delivery':'完成阶段 B 接线的隔离测试构建；真实宿主及原生浏览器复测通过前不用于替换正式插件。'}
    files['BUILD.json']=(json.dumps(build,ensure_ascii=False,indent=2)+'\n').encode()
    files['handoff/stage-B.bundle']=history
    identity='\n## 本次打包身份\n\n源码提交：'+head+'\n\n完整源码 bundle SHA-256：'+sha(history)+'\n'
    files['HANDOFF-STAGE-B.md']+=identity.encode()
    files['SHA256SUMS.txt']=''.join(sha(data)+'  '+name+'\n' for name,data in sorted(files.items())).encode()
    out=dest/NAME
    with zipfile.ZipFile(out,'w',zipfile.ZIP_DEFLATED,compresslevel=9) as archive:
        for name,data in sorted(files.items()):
            entry=zipfile.ZipInfo(PREFIX+name,(2026,11,17,0,0,0))
            entry.compress_type=zipfile.ZIP_DEFLATED;entry.external_attr=0o644<<16
            archive.writestr(entry,data)
    with zipfile.ZipFile(out) as archive:
        assert archive.testzip() is None
        assert len(archive.namelist())==len(set(archive.namelist()))==len(files)
        checks={PREFIX+p:d for d,p in (line.split('  ',1) for line in archive.read(PREFIX+'SHA256SUMS.txt').decode().splitlines())}
        assert set(checks)==set(archive.namelist())-{PREFIX+'SHA256SUMS.txt'}
        assert all(sha(archive.read(name))==digest for name,digest in checks.items())
    digest=sha(out.read_bytes())
    (dest/(NAME+'.sha256')).write_text(digest+'  '+NAME+'\n',encoding='ascii')
    (dest/'HANDOFF-STAGE-B-0.7.0.md').write_text(files['HANDOFF-STAGE-B.md'].decode()+'\n整个交付 ZIP SHA-256：'+digest+'\n',encoding='utf-8')
    (dest/'BUILD.json').write_bytes(files['BUILD.json'])
    print(f'{BUILD} {head}\n{NAME}: {len(files)} members; SHA-256 {digest}')

if __name__=='__main__': main()
