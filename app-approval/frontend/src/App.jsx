import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import DetalheSolicitacao from "./components/DetalheSolicitacao.jsx";
import ListaSolicitacoes from "./components/ListaSolicitacoes.jsx";
import NovaSolicitacao from "./components/NovaSolicitacao.jsx";
import {
  AO_CHEGAR_EVENTO,
  AO_MUDAR_SOLICITACAO,
  LISTAR_EVENTOS,
  LISTAR_SOLICITACOES,
  graphql,
} from "./cliente.js";

export default function App() {
  const [solicitacoes, setSolicitacoes] = useState({});
  const [eventos, setEventos] = useState({});
  const [selecionado, setSelecionado] = useState(null);
  const [conexao, setConexao] = useState("conectando");
  const [aviso, setAviso] = useState(null);

  // Guarda quais solicitacoes ja tiveram a timeline carregada do banco, para
  // nao refazer a query toda vez que o usuario troca de card.
  const timelinesCarregadas = useRef(new Set());

  // A API e o workflow escrevem na mesma solicitacao quase ao mesmo tempo,
  // entao dois snapshots podem chegar fora de ordem. `updatedAt` desempata:
  // um snapshot mais velho nunca sobrescreve um mais novo.
  const guardarSolicitacao = useCallback((solicitacao) => {
    if (!solicitacao?.id) return;
    setSolicitacoes((atual) => {
      const anterior = atual[solicitacao.id];
      if (anterior?.updatedAt && solicitacao.updatedAt && solicitacao.updatedAt < anterior.updatedAt) {
        return atual;
      }
      return { ...atual, [solicitacao.id]: { ...anterior, ...solicitacao } };
    });
  }, []);

  const guardarEvento = useCallback((evento) => {
    if (!evento?.solicitacaoId) return;
    setEventos((atual) => {
      const lista = atual[evento.solicitacaoId] ?? [];
      if (lista.some((e) => e.seq === evento.seq)) return atual;
      return { ...atual, [evento.solicitacaoId]: [...lista, evento].sort((a, b) => a.seq - b.seq) };
    });
  }, []);

  // Carga inicial + as duas subscriptions. Tudo que acontece daqui em diante
  // chega por push do AppSync: a tela nunca faz polling.
  useEffect(() => {
    let vivo = true;

    graphql
      .graphql({ query: LISTAR_SOLICITACOES })
      .then(({ data }) => {
        if (!vivo) return;
        const mapa = {};
        for (const s of data.listSolicitacoes.items) mapa[s.id] = s;
        setSolicitacoes(mapa);
      })
      .catch((erro) => setAviso(`Falha ao carregar solicitações: ${erro.message ?? erro}`));

    const assinaturas = [
      graphql.graphql({ query: AO_MUDAR_SOLICITACAO }).subscribe({
        next: ({ data }) => {
          setConexao("ok");
          guardarSolicitacao(data.onSolicitacaoChanged);
        },
        error: (erro) => {
          setConexao("erro");
          setAviso(`Subscription de solicitações caiu: ${erro?.error?.errors?.[0]?.message ?? "erro desconhecido"}`);
        },
      }),
      graphql.graphql({ query: AO_CHEGAR_EVENTO }).subscribe({
        next: ({ data }) => {
          setConexao("ok");
          guardarEvento(data.onEvent);
        },
        error: () => setConexao("erro"),
      }),
    ];

    const t = setTimeout(() => setConexao((c) => (c === "conectando" ? "ok" : c)), 2000);

    return () => {
      vivo = false;
      clearTimeout(t);
      for (const s of assinaturas) s.unsubscribe();
    };
  }, [guardarSolicitacao, guardarEvento]);

  // Ao abrir uma solicitacao, busca a timeline que ja estava gravada antes de
  // a tela existir. Os eventos novos continuam chegando pela subscription.
  useEffect(() => {
    if (!selecionado || timelinesCarregadas.current.has(selecionado)) return;
    timelinesCarregadas.current.add(selecionado);
    graphql
      .graphql({ query: LISTAR_EVENTOS, variables: { solicitacaoId: selecionado } })
      .then(({ data }) => {
        setEventos((atual) => {
          const jaVistos = new Set((atual[selecionado] ?? []).map((e) => e.seq));
          const novos = data.listEvents.items.filter((e) => !jaVistos.has(e.seq));
          return {
            ...atual,
            [selecionado]: [...(atual[selecionado] ?? []), ...novos].sort((a, b) => a.seq - b.seq),
          };
        });
      })
      .catch(() => timelinesCarregadas.current.delete(selecionado));
  }, [selecionado]);

  const ordenadas = useMemo(
    () => Object.values(solicitacoes).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)),
    [solicitacoes],
  );

  const solicitacaoAberta = selecionado ? solicitacoes[selecionado] : null;

  return (
    <div className="app">
      <header className="cabecalho">
        <div>
          <h1>Mesa de aprovações</h1>
          <p className="subtitulo">
            Solicitação de compra conduzida por uma <strong>AWS Lambda durable function</strong> —
            roteamento por valor, aprovação humana com escalonamento e execução do pagamento em
            uma única execução.
          </p>
        </div>
        <span className={`conexao ${conexao}`}>
          <i />
          {conexao === "ok" ? "tempo real ligado" : conexao === "erro" ? "sem conexão" : "conectando…"}
        </span>
      </header>

      {aviso && (
        <div className="aviso" role="alert">
          {aviso}
          <button type="button" onClick={() => setAviso(null)} aria-label="fechar">
            ×
          </button>
        </div>
      )}

      <main className="grade">
        <section className="coluna-lateral">
          <NovaSolicitacao aoSolicitar={guardarSolicitacao} aoFalhar={setAviso} aoSelecionar={setSelecionado} />
          <ListaSolicitacoes
            solicitacoes={ordenadas}
            selecionado={selecionado}
            aoSelecionar={setSelecionado}
          />
        </section>

        <section className="coluna-principal">
          {solicitacaoAberta ? (
            <DetalheSolicitacao
              solicitacao={solicitacaoAberta}
              eventos={eventos[solicitacaoAberta.id] ?? []}
              aoFalhar={setAviso}
            />
          ) : (
            <div className="vazio">
              <h2>Nenhuma solicitação aberta</h2>
              <p>
                Solicite uma compra ao lado. Se o valor exigir aprovação, ela vai ficar
                <em> aguardando o gestor</em> com a execução durable suspensa — sem consumir
                compute — até alguém clicar em Aprovar ou Rejeitar, que é a decisão humana
                resolvendo o callback.
              </p>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
