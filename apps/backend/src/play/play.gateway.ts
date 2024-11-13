import {
    ConnectedSocket,
    MessageBody,
    OnGatewayConnection,
    OnGatewayInit,
    SubscribeMessage,
    WebSocketGateway,
    WebSocketServer,
} from '@nestjs/websockets';
import { PlayService } from './play.service';
import { Server, WebSocket } from 'ws';
import { IncomingMessage } from 'http';
import { parse } from 'cookie';
import { QuizSubmitDto } from './dto/quiz-submit.dto';
import { BadRequestException, Inject, NotFoundException } from '@nestjs/common';

/**
 * PlayInfo 인터페이스는 클라이언트의 퀴즈 진행 상태를 나타냅니다.
 */
export interface PlayInfo {
    quizZoneId: string;
    submitHandle?: NodeJS.Timeout;
}

/**
 * 웹소켓 서버가 사용자에게 응답할 메시지 형식을 정의합니다.
 */
interface SendEventMessage<T> {
    event: string;
    data: T;
}

/**
 * 퀴즈 게임에 대한 WebSocket 연결을 관리하는 Gateway입니다.
 * 클라이언트가 퀴즈 진행, 제출, 타임아웃 및 결과 요약과 관련된 이벤트를 처리합니다.
 */
@WebSocketGateway({ path: '/play' })
export class PlayGateway implements OnGatewayConnection, OnGatewayInit {
    @WebSocketServer()
    server: Server;

    constructor(
        @Inject('PlayInfoStorage')
        private readonly plays: Map<WebSocket, PlayInfo>,
        private readonly playService: PlayService,
    ) {}

    /**
     * WebSocket 서버 초기화 시, 퀴즈 진행 및 요약 이벤트를 처리하는 핸들러를 설정합니다.
     *
     * @param server - WebSocket 서버 인스턴스
     */
    afterInit(server: Server) {
        server.on('nextQuiz', (client: WebSocket) => this.playNextQuiz(client));
        server.on('summary', (client: WebSocket) => this.summary(client));
    }

    /**
     * WebSocket 연결이 성공적으로 이루어졌을 때 호출됩니다.
     * 클라이언트의 세션 정보를 파싱하여 플레이 정보를 설정합니다.
     *
     * @param client - WebSocket 클라이언트
     * @param request - HTTP 요청 객체
     */
    async handleConnection(client: WebSocket, request: IncomingMessage) {
        const cookies = parse(request.headers.cookie);
        const quizZoneId = cookies['connect.sid'].split('.').at(0).slice(2);
        this.plays.set(client, { quizZoneId });
    }

    /**
     * 퀴즈 게임을 시작하는 메시지를 클라이언트로 전송합니다.
     *
     * @param client - WebSocket 클라이언트
     * @returns {Promise<SendEventMessage<string>>} 퀴즈 시작 메시지
     */
    @SubscribeMessage('start')
    async start(@ConnectedSocket() client: WebSocket): Promise<SendEventMessage<string>> {
        this.server.emit('nextQuiz', client);
        return {
            event: 'start',
            data: 'OK',
        };
    }

    /**
     * 다음 퀴즈를 시작하고 클라이언트에 전달합니다.
     *
     * @param client - WebSocket 클라이언트
     */
    private async playNextQuiz(client: WebSocket) {
        try {
            const playInfo = this.getPlayInfo(client);
            const { quizZoneId } = playInfo;

            const { intervalTime, nextQuiz } = await this.playService.playNextQuiz(quizZoneId);

            client.send(JSON.stringify({ event: 'nextQuiz', data: nextQuiz }));

            playInfo.submitHandle = setTimeout(() => {
                this.quizTimeOut(client);
            }, intervalTime + nextQuiz.playTime);
        } catch (error) {
            if (error instanceof NotFoundException) {
                client.send(JSON.stringify({ event: 'finish' }));
                this.server.emit('summary', client);
            }
        }
    }

    /**
     * 클라이언트가 퀴즈 답안을 제출한 경우 호출됩니다.
     *
     * @param client - WebSocket 클라이언트
     * @param quizSubmit - 퀴즈 제출 데이터
     * @returns {Promise<SendEventMessage<string>>} 제출 완료 메시지
     */
    @SubscribeMessage('submit')
    async submit(
        @ConnectedSocket() client: WebSocket,
        @MessageBody('data') quizSubmit: QuizSubmitDto,
    ): Promise<SendEventMessage<string>> {
        const playInfo = this.getPlayInfo(client);
        const { quizZoneId, submitHandle } = playInfo;

        clearTimeout(submitHandle);
        playInfo.submitHandle = undefined;

        await this.playService.submit(quizZoneId, { ...quizSubmit, receivedAt: Date.now() });

        this.server.emit('nextQuiz', client);

        return {
            event: 'submit',
            data: 'OK',
        };
    }

    /**
     * 주어진 WebSocket 클라이언트의 플레이 정보를 반환합니다.
     *
     * @param client - WebSocket 클라이언트
     * @returns {PlayInfo} 플레이 정보
     * @throws {BadRequestException} 클라이언트에 대한 접속 정보가 없을 경우 예외 발생
     */
    getPlayInfo(client: WebSocket): PlayInfo {
        const playInfo = this.plays.get(client);

        if (playInfo === undefined) {
            throw new BadRequestException('사용자의 접속 정보를 찾을 수 없습니다.');
        }

        return playInfo;
    }

    /**
     * 퀴즈 시간이 초과된 경우 호출되어, 타임아웃을 처리합니다.
     *
     * @param socket - WebSocket 클라이언트
     */
    private async quizTimeOut(socket: WebSocket) {
        const playInfo = this.getPlayInfo(socket);
        const { quizZoneId } = playInfo;

        playInfo.submitHandle = undefined;

        await this.playService.quizTimeOut(quizZoneId);

        socket.send(JSON.stringify({ event: 'quizTimeOut' }));
        this.server.emit('nextQuiz', socket);
    }

    /**
     * 퀴즈 진행이 끝나면 요약 결과를 클라이언트에 전송합니다.
     *
     * @param client - WebSocket 클라이언트
     */
    private async summary(client: WebSocket) {
        const playInfo = this.getPlayInfo(client);
        const { quizZoneId } = playInfo;
        const summaryResult = await this.playService.summary(quizZoneId);

        await this.playService.clearQuizZone(quizZoneId);

        this.plays.delete(client);

        client.send(JSON.stringify({ event: 'summary', data: summaryResult }));
    }
}
