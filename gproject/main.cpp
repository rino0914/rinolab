#include <cstdio>
#include <iostream>
#include "const/types.h"
#include <thread>
#include "tramakethread.h"
#include <string>
#include <list>
using namespace std;

const string APP_NAME  ="deploy_tramake";
std::list<Gthread> *threads;

bool initConfig();

bool createThreads();
bool initThreads();

int main(int argc, char* argv[]){

    std::cout<<"Loading Configuration..."<<std::endl;
    if (!initConfig()){
        std::cerr<<"Failed to load configuration."<<std::endl;
        return false;
    }
    std::cout<<"Complete Loading Configuration!"<<std::endl;
    
    std::cout<<"Creating Resource..."<<std::endl;
    if (!createThreads()){
        std::cerr<<"Failed to Create Resource."<<std::endl;
        return false;
    }
    std::cout<<"Complete Creating Resource! count="<<threads.size()<<std::endl;
    
    std::cout<<"Initiallzing Resource..."<<std::endl;
    if (!createThreads()){
        std::cerr<<"Failed to initrailzie Resource."<<std::endl;
        return false;
    }
    std::cout<<"Complete initailzing."<<std::endl;

    
    std::cout<<APP_NAME<<"Process Started."<<std::endl;
    return 0;
}

bool createThreads(){
    try{
        Gthread *tmk = new Tramakethread();
        threads->emplace_back(tmk);
        std::cout<<"succeed to create resource. "<<tmk->getName()<<std::endl;

    }catch (...) { // 기타 모든 예외
        std::cout << "Unknown exception!" << std::endl;
        return false;
    }
    return true;
}

bool initConfig(){
    
    return true;
}

bool initThreads(){
    for(auto th = threads->begin(); th != threads->end(); th++){
        th->init();

    }
}