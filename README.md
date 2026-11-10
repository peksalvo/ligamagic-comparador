# Comparador internacional para LigaMagic

Acrescenta, abaixo dos preços de cada card, uma linha com a diferença percentual
entre o preço da Liga e o preço no exterior (TCGplayer / Cardmarket).

- `▼ 23%` verde → mais barato na Liga
- `▲ 41%` vermelho → mais barato lá fora
- `≈ 3%` cinza → dentro da faixa de empate
- borda tracejada e `TCG?` → o print exato não foi encontrado, o preço é de outra edição

O resumo da página ("36 de 46 mais baratas na Liga" + câmbio) entra no cabeçalho da
edição, junto da contagem de cards. Se o cabeçalho não for encontrado, vira um
balão flutuante no canto inferior esquerdo, que pode ser fechado.

## Instalação

Chrome: `chrome://extensions` → modo desenvolvedor → "Carregar sem compactação".
Opera: `opera://extensions`, mesmo fluxo.

## Decisões de projeto

**Códigos de variante da Liga são recuperados pelo sufixo, com validação.** A Liga
inventa códigos para variantes de acabamento prefixando o código real:

```
FNSOS  =  FN (Field Notes)  + SOS
RFBRO  =  RF (Retro Frame)  + BRO
```

Nenhum dos dois existe no Scryfall, então pedir por eles dava 404, a extensão caía
na busca por nome e devolvia o preço do print BASE — duas versões diferentes da
mesma carta na mesma edição terminavam com preços idênticos, e sem nenhum sinal de
que algo estava errado.

A recuperação usa o sufixo mais longo que seja um set de verdade, validado contra
a lista de `/sets` do Scryfall (cache de 30 dias). A validação é o que separa isso
de gerar chutes: código desconhecido e sem sufixo válido vai direto para busca por
nome, sem gastar requisição. E como um sufixo pode em teoria acertar um set real
com a carta errada, o match por print confere o nome antes de aceitar.

O número da carta não precisa dessa ginástica — `num=` já vem na URL, inclusive nas
variantes.

**Resolução em duas passadas.** Primeiro por print exato
(`{set, collector_number}`), depois, só para o que não foi encontrado, por nome
(`{name}`). Sem a segunda passada, um único erro na detecção do set code fazia o
lote inteiro voltar vazio: o `not_found` do Scryfall não traz nada, então não há
como fazer fallback dentro da mesma resposta, e a página ficava sem nenhum selo.
Custa uma requisição a mais e transforma silêncio total em "preço de outro print,
marcado como aproximado". O resumo diz quantas cartas caíram nesse caminho.

**TTL curto para o "não encontrei", e purga na troca de versão.** 6h em vez de
24h, porque um not_found normalmente é bug de identificação da extensão, não
ausência no Scryfall. E toda mudança de versão apaga as entradas `missing` e
`approx`: sem isso, a versão nova pede a mesma chave, encontra o erro da versão
antiga no cache e nem consulta a API — o bug sobrevive à própria correção.

**Scryfall como fonte, não TCGplayer/Cardmarket direto.** O Cardmarket exige OAuth
com credenciais aprovadas e restringe uso; a API pública do TCGplayer está fechada
para novos desenvolvedores. O Scryfall já agrega os dois em `prices.usd` /
`prices.eur` (e as variantes `_foil`), é grátis, sem chave e com CORS liberado.

**`/cards/collection` em lotes de 75.** Uma página de edição com 60 cards resolve em
uma requisição, não sessenta. Isso elimina fila, lazy load por viewport e qualquer
risco de rate limit — que era a principal complicação de fazer isso na listagem.

**Identificação vem da URL, não de matching de nome.** Cada link de card na Liga
carrega o nome em inglês e o collector number:
`?view=cards/card&ed=479911&num=702&card=Mother of Runes&aux=Madre das Runas`.
Somando o set code do Scryfall, que a Liga imprime no cabeçalho e usa na própria
busca (`ed=clb`), dá pra pedir o print exato: `{set: "clb", collector_number: "702"}`.
Sem dicionário pt→en, sem busca fuzzy.

**Zero seletores CSS da LigaMagic.** A extensão ancora no formato do link do card e
no padrão `R$ 0,00`, subindo a árvore até achar o ancestral que contém preço e
exatamente uma carta. Redesign de layout na Liga não quebra a extensão; só uma
mudança no formato da URL quebraria.

**Agrupamento por carta antes de subir a árvore.** Cada card tem dois links para a
mesma carta (imagem e nome). Subindo a partir de cada âncora isoladamente, elas
resolvem para ancestrais diferentes — um o tile, outro só a linha de preço — e a
carta ganha dois selos. O código agrupa as âncoras por identidade da carta e só
então procura o ancestral que contém todas elas.

**Nada sobreposto ao card.** Overlay sobre a arte cobre o nome da carta; sobre a
linha de preço cobre o preço da Liga. A faixa ocupa uma linha própria abaixo dos
preços, o que também alinha os percentuais na vertical entre os cards — é o que
faz a varredura visual funcionar.

**Afrouxar a caixa em vez de procurar espaço nela.** O tile da busca arbitrária
tem altura fixa e a linha de botões ancorada no rodapé, então a faixa entra no
fluxo e é encoberta — pior em carta com nome em português, porque a linha extra de
texto a empurra mais para baixo. A extensão libera `height`, `max-height` e
`overflow` na cadeia entre a faixa e o tile, e dá ao tile a altura original mais a
da faixa. Serve para os dois layouts: se a linha de botões é absoluta, desce junto
com o rodapé; se está no fluxo, deixa de ser cortada.

**Teste de cobertura com `elementFromPoint`, restrito ao tile.** Medir o retângulo
da faixa não detecta nada: um elemento absoluto por cima a deixa com altura normal
e dentro do tile, e ainda assim invisível. O teste certo é perguntar quem está no
topo da pilha naquele ponto — mas só conta se esse elemento pertencer ao tile. O
problema estrutural é a linha de botões do próprio tile; o preview de carta
ampliada que a Liga abre no hover cobre os vizinhos e é estado transitório, e
tratá-lo como cobertura jogava para o topo faixas que estavam perfeitas.

**Baseline desligada antes de mexer em altura.** Na busca arbitrária os tiles são
`inline-block`, alinhados pela baseline: mudar a altura de um desloca os vizinhos
da mesma linha e a fileira vira escada. `vertical-align: top` no tile e na célula
que o contém elimina a dependência. Na visão por edição os tiles são itens de
grid/flex esticados, e é por isso que a mesma mutação só quebrava um dos dois
layouts.

**Altura só é reescrita quando há overflow real** (`scrollHeight > clientHeight`).
Antes, qualquer altura fixa era substituída, inclusive onde a faixa já caberia —
mutação gratuita é o que produz efeito colateral em layout alheio.

**O afrouxamento é reversível.** `relaxChain` devolve um undo, aplicado quando o
fallback dispara — senão a altura extra fica sobrando como espaço vazio no rodapé
do tile.

**Página da carta tem caminho próprio, ancorado na tabela de preços.** Na listagem
o alvo é o tile; na página individual não existe tile, e a busca por ancestral com
preço acaba no container da página inteira. Lá a extensão pega o nome da URL, o
preço da primeira linha de "Preço Médio de Venda no Marketplace" e insere a faixa
logo abaixo dessa tabela.

Ancorar no nome em inglês, como eu tentei antes, só funciona em carta que tem nome
em português: aí o nome em inglês é um subtítulo distinto. Com `aux=` vazio o nome
em inglês é o próprio título e reaparece em vários pontos da página, então "o
primeiro nó cujo texto é o nome da carta" cai em qualquer lugar, inclusive em nó
oculto. A tabela de preços é única e é o lugar semanticamente certo.

**Nomes compostos (duplas, split, aventura).** A Liga manda `A %2F%2F B` com
espaçamento variável em volta do separador. O nome é normalizado para a forma do
Scryfall, e o retry por nome usa a **face frontal** — o nome composto depende de
ordem das faces e formatação, a face frontal não. A indexação da resposta aceita
as duas formas, porque se pede por uma e o Scryfall pode responder com a outra.

**Parâmetro da URL é normalizado.** A busca por edição chega como
`card=ed%3Dkld`, mas às vezes com um `+` no fim (`card=ed%3Decl+`), que decodifica
como espaço e derruba o caminho principal de detecção do set code.

**Na página da carta, o código de edição volta a ser lido do DOM.** Existe UMA
carta ali, então um código de página é um código de carta — a proibição abaixo é
sobre listagens. Ainda assim o padrão é apertado: só aceita rótulo curto
terminando em parênteses, como `Rara (MKM)`, e o filtro de ano descarta
`Assassinato na Mansão Karlov (2024)`.

**Foil e não-foil são comparações separadas.** A tabela da Liga traz duas linhas
de três preços; a extensão compara a linha Normal com `prices.usd`/`prices.eur` e
a linha Foil com `usd_foil`/`eur_foil`. Comparar preço foil com referência
não-foil era erro silencioso e grande.

**Set code é propriedade da carta, não da página.** Numa listagem de edição as
duas coisas coincidem, e é tentador generalizar a coincidência. Numa busca por
nome arbitrária, não: cada linha é de uma edição diferente. Aplicar um código de
página a todas as linhas produz preços errados com aparência de corretos — pior
que não ter código nenhum, porque a busca por nome ao menos vem marcada como
aproximada. Por isso o código de página vem só do parâmetro `ed=` da URL, que é
a única fonte que garante edição única, e nunca de varredura do DOM.

**Collector number como conferência.** Sem set code, a extensão compara o número
que a Liga mostra com o do print que o Scryfall devolveu. Se divergem, o selo vai
marcado como aproximado.

**Toda rede no service worker.** Cache compartilhado entre abas, dedupe e chunking
num lugar só, host_permissions confinadas. TTL de 12h para preço (o Scryfall
atualiza 1x/dia), 6h para câmbio, 24h para "não encontrado".

**Câmbio da AwesomeAPI** (`economia.awesomeapi.com.br`), sem chave, USD-BRL e
EUR-BRL numa chamada.

## A faixa

Uma linha por mercado, com a sigla, a diferença e o preço já convertido:

```
TCG  ▲ 12%   R$ 84,64
CM   ▼  3%   R$ 98,10
```

Os dois preços já vêm com o fator de importação aplicado, para serem comparáveis
entre si e com o preço da Liga. O mercado configurado em opções não decide mais o
que aparece — os dois aparecem sempre — só o que entra na contagem do resumo.

O tooltip acrescenta o valor em moeda original, o print de onde veio o preço e
qual mercado alimentou a contagem.

Na página da carta a faixa vira um bloco com uma seção por acabamento:

```
NORMAL   TCG ▲ 12%  R$ 84,64      CM ▼ 3%  R$ 98,10
FOIL     TCG ▲ 45%  R$ 89,50      CM ▲ 38% R$ 94,00
```

## Limitações honestas

1. **Print em português vs. preço em inglês.** As cartas da Liga são PT; os preços
   do TCGplayer/Cardmarket referem-se majoritariamente ao print em inglês. O
   mercado brasileiro de cartas em português tem dinâmica própria, então a
   comparação é de tendência, não de arbitragem exata.
2. **Condição não entra na conta.** O menor preço da Liga pode ser um SP/MP; o
   preço de mercado externo é outra base.
3. **Frete, IOF e intermediário** não estão no número. É pra isso que existe o
   fator de importação nas opções — com 1,00 você compara preço puro.
4. **Códigos de edição próprios da Liga.** Os do padrão prefixo+código são
   recuperados (ver acima). Os que não seguem padrão nenhum caem na busca por
   nome, sinalizados com borda tracejada.
5. **Busca por nome (não por edição)** cai no match por nome no Scryfall, que
   devolve *um* print da carta, não necessariamente a edição da linha. Esses selos
   aparecem com borda tracejada. Consertar isso exige mapear o `ed=<id interno>`
   da Liga para o set code — dá pra construir esse mapa incrementalmente, já que
   toda página de edição entrega os dois lados da relação de uma vez.
6. Preços do Scryfall são cortesia de parceiros e não devem ser tratados como
   cotação oficial.

## Próximos passos naturais

- **Set code por linha em buscas por nome.** É o buraco que resta. Precisa de uma
  fonte por card no DOM da Liga: o `alt`/`title`/`src` do ícone da edição, ou a
  coluna de edição da exibição em lista.
- Chave de cache por nome colapsa prints diferentes da mesma carta numa busca por
  nome — todas as linhas recebem o mesmo preço aproximado até existir código por
  linha.
- Filtro "mostrar só as N% mais baratas na Liga" no painel de resumo.
- Reordenar a grade por delta (dá pra fazer, mas é o tipo de manipulação de DOM
  que quebra com qualquer mudança de layout).

## Pagamento nas páginas de pedido das lojas (0.7.0+)

Nas páginas de pedido das lojas LigaMagic (`?view=ecom/compra`, em qualquer domínio de loja), a extensão coloca logo abaixo do número do pedido um **resumo de pagamento**:

- **Valor total** em destaque, com botão para copiar só o número (ex.: `162,35`);
- **Chave Pix**, com botão de copiar;
- **Titular** e **banco / agência / conta** (conta com botão de copiar);
- botão **Gerar QR Code Pix**, que monta um BR Code estático (padrão EMV do Banco Central) com a chave, o valor total e o número do pedido como identificador, e mostra o QR e o "copia e cola".

Lojas que informam só agência e conta (sem chave Pix) recebem o resumo sem o QR.

### Enviar por e-mail (0.9.0)

Muitas lojas pararam de mandar o e-mail de "novo pedido". O botão **Enviar por e-mail** do resumo abre o Gmail com tudo preenchido; é só clicar em Enviar:

- **Para:** o e-mail configurado nas opções da extensão (na primeira vez, a extensão pergunta e guarda em `chrome.storage.sync`; nada fica no código);
- **Assunto:** `[Loja] Pedido #N – R$ total`;
- **Corpo:** link do pedido, itens (quantidade, nome, código, edição, idioma, condição, foil, preço e link da carta na LigaMagic: `?view=cards/card&card=<nome>`; em "A / B" vai a primeira parte, em carta dupla "A // B" vai o nome inteiro), totais (itens, desconto, frete, crédito, total) e os dados de pagamento, incluindo o Pix copia e cola com o valor.

Endereço e CPF do comprador ficam de fora. Se o pedido for grande demais para caber no link do Gmail, o texto vai para a área de transferência e o Gmail abre pedindo para colar.

Detalhes:

- Arquivos: `pix.js`, `pix.css` e `lib/qrcode.js` (qrcode-generator 1.4.4, MIT, Kazuhiko Arase; incluído no projeto, sem CDN).
- Como reconhece a página: o manifest injeta o script em `https://*/*`, filtrado por `include_globs` para URLs com `view=ecom/compra` (o formato da plataforma de lojas da LigaMagic). O script só age se a página tiver "Valor Total: R$ x" **e** "Chave PIX:" ou "Conta:". Nenhum seletor da loja, mesmo princípio do comparador.
- O nome e a cidade no BR Code são só informativos; o app do banco mostra o titular real da chave. Confira sempre antes de pagar.
