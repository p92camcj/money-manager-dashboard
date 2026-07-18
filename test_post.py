import urllib.request, urllib.parse
data = {
    'mbDate': '2026-03-27T10:00:00',
    'mbCash': '0.02',
    'inOutType': 'Egreso',
    'inOutCode': '1',
    'payType': '👛 Efectivo',
    'mbCategory': '🍴 ALIMENTACIÓN',
    'subCategory': '🍟 Restaurantes',
    'mbContent': 'A_TEST_OMITTING_MCID',
    'assetId': '11'
}
req = urllib.request.Request('http://192.168.5.248:8888/moneyBook/create', data=urllib.parse.urlencode(data).encode('utf-8'))
try: 
    print("CREATE RESULT:", urllib.request.urlopen(req).read().decode('utf-8'))
    # Fetch list to see if A_TEST_OMITTING_MCID exists
    print("VERIFY RESULT:")
    print(urllib.request.urlopen("http://192.168.5.248:8888/moneyBook/getDataByPeriod?startDate=2026-03-26&endDate=2026-03-28").read().decode('utf-8')[:3000])
except Exception as e: print(e)
