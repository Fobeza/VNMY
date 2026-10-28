// Synthetic fixture for jsdom integration tests. Never included in the app build.
export const integrationStory = {
  schema: 1,
  id: 'story_test_integration',
  title: 'Тестовая новелла',
  author: 'VNMY tests',
  universe: 'silent-rails',
  accent: '#e0b072',
  characters: [
    { id: 'anya', name: 'Аня', sprites: { neutral: 'data:image/webp;base64,UklGRg==' } },
    { id: 'mark', name: 'Марк', sprites: { neutral: 'data:image/webp;base64,UklGRg==' } },
  ],
  scenes: [
    {
      id: 'sc_start', name: 'Платформа', bg: 'data:image/webp;base64,UklGRg==',
      cast: [{ char: 'anya', sprite: 'neutral', pos: 'center' }],
      steps: [
        { id: 't1', text: '02:14. Дождь стучит по крыше.' },
        { id: 't2', text: 'Куда пойдём?', choices: [
          { text: 'В вагон', goto: 'sc_train:t1' },
          { text: 'Домой', goto: 'sc_home:t1' },
        ] },
      ],
    },
    {
      id: 'sc_train', name: 'Вагон', bg: 'data:image/webp;base64,UklGRg==',
      cast: [
        { char: 'anya', sprite: 'neutral', pos: 'left' },
        { char: 'mark', sprite: 'neutral', pos: 'right' },
      ],
      steps: [
        { id: 't1', speaker: 'anya', text: 'Поезд тронулся.' },
        { id: 't2', speaker: 'mark', text: 'Мы успели.', end: true, endTitle: 'КОНЕЦ · Вагон' },
      ],
    },
    {
      id: 'sc_home', name: 'Дом', bg: '', cast: [{ char: 'anya', sprite: 'neutral' }],
      steps: [{ id: 't1', text: 'Мы остались.', end: true, endTitle: 'КОНЕЦ · Дом' }],
    },
  ],
};
