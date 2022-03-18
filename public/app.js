mdc.ripple.MDCRipple.attachTo(document.querySelector('.mdc-button'));

// DEfault configuration - Change these if you have a different STUN or TURN server.
const configuration = {
  iceServers: [
    {
      urls: [
        'stun:stun1.l.google.com:19302',
        'stun:stun2.l.google.com:19302',
      ],
    },
  ],
  iceCandidatePoolSize: 10,
};

let peerConnection = null;
let localStream = null; // результат navigator.mediaDevices.getUserMedia({video: true, audio: true})
let remoteStream = null;
let roomDialog = null;
let roomId = null;

/**
 * Запрашиваем доступ к камере и микрофону
 * @return {Promise<void>}
 */
async function openUserMedia() {
  const stream = await navigator.mediaDevices.getUserMedia({video: true, audio: true});
  document.querySelector('#localVideo').srcObject = stream;
  localStream = stream;
  // Вот здесь мы добавляем media для #remoteVideo
  remoteStream = new MediaStream();
  document.querySelector('#remoteVideo').srcObject = remoteStream;

  console.log('Stream:', document.querySelector('#localVideo').srcObject);
  document.querySelector('#cameraBtn').disabled = true;
  document.querySelector('#joinBtn').disabled = false;
  document.querySelector('#createBtn').disabled = false;
  document.querySelector('#hangupBtn').disabled = false;
}

/**
 * Создаем комнату
 * @return {Promise<void>}
 */
async function createRoom() {
  document.querySelector('#createBtn').disabled = true;
  document.querySelector('#joinBtn').disabled = true;
  // Подключаемся к хранилищу firebase
  const db = firebase.firestore();
  // Создаем новую комнату в firebase
  const roomRef = await db.collection('rooms').doc();

  console.log('Create PeerConnection with configuration: ', configuration);
  // Интерфейс RTCPeerConnection представляет соединение WebRTC между локальным пиром (участником соединения) на локальном компьютере
  // и удалённым пиром на удалённом компьютере. Он предоставляет методы для соединения с удалённым участником соединения, обслуживания,
  // мониторинга и закрытия соединения.
  peerConnection = new RTCPeerConnection(configuration);

  registerPeerConnectionListeners();

  // Добавляем в соединение созданное RTCPeerConnection наш медиа (audio, video)
  localStream.getTracks().forEach(track => {
    peerConnection.addTrack(track, localStream);
  });

  // Code for creating a room below
  // Метод createOffer() интерфейса RTCPeerConnection инициирует создание предложения SDP с целью запуска нового соединения WebRTC
  // с удаленным узлом. Предложение SDP включает в себя информацию о любых объектах MediaStreamTrack, уже подключенных к сеансу WebRTC,
  // кодеке и параметрах, поддерживаемых браузером, а также о любых кандидатах, уже собранных агентом ICE для отправки по сигнальному каналу
  // потенциальному одноранговому узлу. запросить соединение или обновить конфигурацию существующего соединения.
  const offer = await peerConnection.createOffer();
  // Метод setLocalDescription() RTCPeerConnection изменяет локальное описание, связанное с соединением.
  // Это описание определяет свойства локального конца соединения, включая формат носителя.
  // Метод принимает единственный параметр — описание сеанса — и возвращает обещание, которое выполняется после изменения описания асинхронно.
  await peerConnection.setLocalDescription(offer);

  const roomWithOffer = {
    offer: {
      type: offer.type,
      sdp: offer.sdp
    }
  }
  // Сохраняем предложение (offer)
  await roomRef.set(roomWithOffer);
  const roomId = roomRef.id;
  console.log(`New room created with SDP offer. Room ID: ${roomRef.id}`);
  document.querySelector('#currentRoom').innerText = `Current room is ${roomId} - You are the caller!`
  // Code for creating a room above

  // Code for collecting ICE candidates below
  // Создаем коллекцию callerCandidates в хранилище firebase
  const callerCandidatesCollection = roomRef.collection('callerCandidates');

  // Событие объекта RTCPeerConnection возникает, когда специальный объект ICE кандидата (RTCIceCandidate) сгенерирован RTCPeerConnection
  // и готов для передачи удалённому пиру по каналу сигнализации.
  // Сам сгенерированный объект кандидата передаётся в параметр вызванного обработчика.
  peerConnection.addEventListener('icecandidate', event => {
    if (!event.candidate) {
      console.log('Got final candidate!');
      return;
    }
    console.log('Got candidate: ', event.candidate);
    callerCandidatesCollection.add(event.candidate.toJSON());
  });
  // Code for collecting ICE candidates above
  // Событие track возникает после того, как новый объект трека был добавлен в один из объектов интерфейса RTCRtpReceiver (en-US),
  // которые входят в состав соединения.
  peerConnection.addEventListener('track', event => {
    console.log('Got remote track:', event.streams[0]);
    event.streams[0].getTracks().forEach(track => {
      console.log('Add a track to the remoteStream:', track);
      // Здесь мы добавляем контент для remoteStream и видео начинает отображаться
      remoteStream.addTrack(track);
    });
  });

  // Listening for remote session description below

  roomRef.onSnapshot(async snapshot => {
    const data = snapshot.data();
    if (!peerConnection.currentRemoteDescription && data && data.answer) {
      console.log('Got remote description: ', data.answer);
      // Интерфейс RTCSessionDescription описывает один конец соединения — или потенциальное соединение — и то, как он настроен.
      // Каждое RTCSessionDescription состоит из типа описания, указывающего, какую часть процесса согласования предложения/ответа
      // оно описывает, и из дескриптора сеанса SDP.
      const rtcSessionDescription = new RTCSessionDescription(data.answer);
      // Метод setRemoteDescription() RTCPeerConnection устанавливает указанное описание сеанса в качестве текущего предложения или ответа
      // удаленного узла. В описании указываются свойства удаленного конца соединения, включая формат носителя. Метод принимает единственный
      // параметр — описание сеанса — и возвращает обещание, которое выполняется после изменения описания асинхронно.
      await peerConnection.setRemoteDescription(rtcSessionDescription);
    }
  });
  // Listening for remote session description above

  // Listen for remote ICE candidates below
  // прослушивает добавленние кандидат ICE от удаленного узла и добавляет их в RTCPeerConnection
  roomRef.collection('calleeCandidates').onSnapshot(snapshot => {
    snapshot.docChanges().forEach(async change => {
      if (change.type === 'added') {
        let data = change.doc.data();
        console.log(`Got new remote ICE candidate: ${JSON.stringify(data)}`);
        // Когда веб-сайт или приложение, использующее RTCPeerConnection, получает нового кандидата ICE от удаленного узла
        // по своему сигнальному каналу, он доставляет только что полученного кандидата агенту ICE браузера,
        // вызывая RTCPeerConnection.addIceCandidate(). Это добавляет этого нового удаленного кандидата к удаленному описанию
        // RTCPeerConnection, которое описывает состояние удаленного конца соединения.
        await peerConnection.addIceCandidate(new RTCIceCandidate(data));
        // Интерфейс RTCIceCandidate — часть API WebRTC — представляет конфигурацию-кандидата Interactive Connectivity Establishment (ICE),
        // которую можно использовать для установления RTCPeerConnection.
      }
    });
  });
  // Listen for remote ICE candidates above
}

/**
 * Открываем модалку для подключения к комнате
 */
function joinRoom() {
  document.querySelector('#createBtn').disabled = true;
  document.querySelector('#joinBtn').disabled = true;

  document.querySelector('#confirmJoinBtn').
      addEventListener('click', async () => {
        roomId = document.querySelector('#room-id').value;
        console.log('Join room: ', roomId);
        document.querySelector('#currentRoom').innerText = `Current room is ${roomId} - You are the callee!`;
        await joinRoomById(roomId);
      }, {once: true});
  roomDialog.open();
}

/**
 * Подключение к комнате
 * @param {string} roomId - id комнаты
 * @return {Promise<void>}
 */
async function joinRoomById(roomId) {
  const db = firebase.firestore();
  const roomRef = db.collection('rooms').doc(`${roomId}`);
  const roomSnapshot = await roomRef.get();
  console.log('Got room:', roomSnapshot.exists);

  if (roomSnapshot.exists) {
    console.log('Create PeerConnection with configuration: ', configuration);
    peerConnection = new RTCPeerConnection(configuration);

    registerPeerConnectionListeners();

    localStream.getTracks().forEach(track => {
      peerConnection.addTrack(track, localStream);
    });

    // Code for collecting ICE candidates below
    const calleeCandidatesCollection = roomRef.collection('calleeCandidates');

    peerConnection.addEventListener('icecandidate', event => {
      if (!event.candidate) {
        console.log('Got final candidate!');
        return;
      }
      console.log('Got candidate: ', event.candidate);
      calleeCandidatesCollection.add(event.candidate.toJSON());
    });
    // Code for collecting ICE candidates above

    peerConnection.addEventListener('track', event => {
      console.log('Got remote track:', event.streams[0]);
      event.streams[0].getTracks().forEach(track => {
        console.log('Add a track to the remoteStream:', track);
        remoteStream.addTrack(track);
      });
    });

    // Code for creating SDP answer below
    const offer = roomSnapshot.data().offer;
    await peerConnection.setRemoteDescription(offer);
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);

    const roomWithAnswer = {
      answer: {
        type: answer.type,
        sdp: answer.sdp
      }
    }
    await roomRef.update(roomWithAnswer);
    // Code for creating SDP answer above

    // Listening for remote ICE candidates below
    roomRef.collection('callerCandidates').onSnapshot(snapshot => {
      snapshot.docChanges().forEach(async change => {
        if (change.type === 'added') {
          let data = change.doc.data();
          console.log(`Got new remote ICE candidate: ${JSON.stringify(data)}`);
          await peerConnection.addIceCandidate(new RTCIceCandidate(data));
        }
      });
    });
    // Listening for remote ICE candidates above
  }
}

async function hangUp(e) {
  const tracks = document.querySelector('#localVideo').srcObject.getTracks();
  tracks.forEach(track => {
    track.stop();
  });

  if (remoteStream) {
    remoteStream.getTracks().forEach(track => track.stop());
  }

  if (peerConnection) {
    peerConnection.close();
  }

  document.querySelector('#localVideo').srcObject = null;
  document.querySelector('#remoteVideo').srcObject = null;
  document.querySelector('#cameraBtn').disabled = false;
  document.querySelector('#joinBtn').disabled = true;
  document.querySelector('#createBtn').disabled = true;
  document.querySelector('#hangupBtn').disabled = true;
  document.querySelector('#currentRoom').innerText = '';

  // Delete room on hangup
  if (roomId) {
    const db = firebase.firestore();
    const roomRef = db.collection('rooms').doc(roomId);
    const calleeCandidates = await roomRef.collection('calleeCandidates').get();
    calleeCandidates.forEach(async candidate => {
      await candidate.delete();
    });
    const callerCandidates = await roomRef.collection('callerCandidates').get();
    callerCandidates.forEach(async candidate => {
      await candidate.delete();
    });
    await roomRef.delete();
  }

  document.location.reload(true);
}

function registerPeerConnectionListeners() {
  peerConnection.addEventListener('icegatheringstatechange', () => {
    console.log(`ICE gathering state changed: ${peerConnection.iceGatheringState}`);
  });

  peerConnection.addEventListener('connectionstatechange', () => {
    console.log(`Connection state change: ${peerConnection.connectionState}`);
  });

  peerConnection.addEventListener('signalingstatechange', () => {
    console.log(`Signaling state change: ${peerConnection.signalingState}`);
  });

  peerConnection.addEventListener('iceconnectionstatechange ', () => {
    console.log(`ICE connection state change: ${peerConnection.iceConnectionState}`);
  });
}

function init() {
  document.querySelector('#cameraBtn').addEventListener('click', openUserMedia);
  document.querySelector('#hangupBtn').addEventListener('click', hangUp);
  document.querySelector('#createBtn').addEventListener('click', createRoom);
  document.querySelector('#joinBtn').addEventListener('click', joinRoom);
  roomDialog = new mdc.dialog.MDCDialog(document.querySelector('#room-dialog'));
}

init();
