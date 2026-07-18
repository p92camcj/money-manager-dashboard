import urllib.request
xml = urllib.request.urlopen("http://192.168.5.248:8888/moneyBook/getDataByPeriod?startDate=2026-03-27&endDate=2026-03-29").read().decode('utf-8')
if "A_TEST_OMITTING_MCID" in xml:
    print("SUCCESS: Transaction was saved!")
else:
    print("FAILED: Transaction not found in DB.")
