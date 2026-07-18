import urllib.request
js_files = ['init.js', 'moneybookLeft.js', 'moneybook.js', 'assetDashBoard.js', 'assetDetailList.js', 'asset.js', 'setting.js', 'layout.js']
all_js = ''
for j in js_files:
    url = f'https://realbyteapps.net/dev_pcmanager/v330/js/{j}'
    try: all_js += urllib.request.urlopen(url).read().decode('utf-8')
    except Exception as e: print(e)
with open('all_mm.js', 'w', encoding='utf-8') as f: f.write(all_js)
print('Done.')
