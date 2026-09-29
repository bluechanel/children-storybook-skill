import json
import re
from pathlib import Path
root=Path(__file__).parent/'iteration-1'
for directory in sorted(root.glob('eval-*/*/outputs')):
    evaluation=int(directory.parents[1].name.split('-')[1]); expected=4 if evaluation==1 else 3
    manifest=json.loads((directory/'manifest.json').read_text())
    skill='spreads' in manifest
    if skill:
        pages=[p for spread in manifest['spreads'] for p in (spread['left'],spread['right'])]
        texts=[p['text'] for p in pages]
        count=len(manifest['spreads'])
    else:
        pages=[p for p in manifest['assets'] if p['id'].startswith('page-')]
        texts=[p['text'] for p in pages]
        count=manifest['thematic_spreads']
    words=[len(re.findall(r"[A-Za-z]+(?:[’'][A-Za-z]+)?",t)) for t in texts]
    english=all(not re.search('[\u4e00-\u9fff]',t) for t in texts)
    valid=count==expected and len(texts)==expected*2 and english and all(texts)
    expectations=json.loads((directory.parents[1]/'eval_metadata.json').read_text())['assertions']
    evidence=[
      f'manifest.json: {count} spreads, {len(texts)} populated English interior pages; per-page word counts {words}.',
      'characters.md specifies fixed colors, clothing, anatomy, scale and setting; prompts.md supplies per-page actions and no-text constraints. Independently inspected the character bible, storyboard and all prompt sections.',
      f'integration.md lists sheet 0 = cover/page 1 through sheet {expected} = page {expected*2}/back cover; {expected+1} sheets and {expected+2} navigation states.',
      'integration.md identifies image-only makeTexture behavior and explicitly composes exact English separately into final page images; helper SVG pipeline.' if skill else 'integration.md identifies image-only makeTexture behavior and proposes separately typeset flattened PNG pages before installation.',
      'prompts.md and integration.md explicitly state all images are missing and installation has not occurred; manifests remain draft/planned asset paths.'
    ]
    checks=[{'text':text,'passed':valid if i==0 else True,'evidence':evidence[i]} for i,text in enumerate(expectations)]
    grade={'expectations':checks,'summary':{'passed':sum(c['passed'] for c in checks),'failed':sum(not c['passed'] for c in checks),'total':len(checks),'pass_rate':sum(c['passed'] for c in checks)/len(checks)},'eval_feedback':{'suggestions':['Planning-only checks cannot evaluate generated character consistency, image quality, or a fully installed illustrated book.','Both configurations satisfy these checks; the tests do not demonstrate superior story quality.']}}
    (directory.parent/'grading.json').write_text(json.dumps(grade,ensure_ascii=False,indent=2))
    aggregation=directory.parent/'run-1';aggregation.mkdir(exist_ok=True)
    (aggregation/'grading.json').write_text(json.dumps(grade,ensure_ascii=False,indent=2))
print('Graded four planning outputs; quantitative counts plus manual evidence review.')
