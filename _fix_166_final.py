with open('章节/第166章_继续.txt', 'r') as f:
    content = f.read()

old = '他的呼吸里慢慢分开。\n\n五十里。钱来之山。西山经第一座山。'
new = '他的呼吸里慢慢分开。雾在身后合拢。脚下的'没有'很轻，每一步都像在踩灭一个还没点着的火。\n\n五十里。钱来之山。西山经第一座山。'

if old in content:
    content = content.replace(old, new)
    with open('章节/第166章_继续.txt', 'w') as f:
        f.write(content)
    print('OK')
else:
    print('MISS')
