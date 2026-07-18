import urllib.request
try: 
    print(urllib.request.urlopen("http://192.168.5.248:8888/moneyBook/nonexistent123").getcode())
except Exception as e: 
    print(e)
