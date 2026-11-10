export const profilePrompt = {
  id: 'personal-profile',
  title: '我的个人资料',
  order: 10,
  render: ({ profileDirectory }) => `我的个人资料放在这里：\n${profileDirectory}\n\n想了解、回顾和自己有关的资料时，可以用 glob 找找这里有哪些文件，再用 read 打开感兴趣的内容。里面具体有什么，读过以后再说，不用只凭目录名字猜。`,
}
